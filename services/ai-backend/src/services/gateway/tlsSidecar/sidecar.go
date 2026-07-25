// TLS Sidecar — Go uTLS reverse proxy for browser fingerprint simulation.
//
// Build: go build -o tls-sidecar sidecar.go
// Usage: ./tls-sidecar -port 9150 -fingerprint chrome_auto
//
// Listens on 127.0.0.1:<port> as an HTTP CONNECT proxy.
// Outbound TLS connections use uTLS to mimic browser ClientHello fingerprints,
// bypassing Cloudflare and similar TLS-fingerprint-based bot detection.
package main

import (
	"crypto/tls"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	utls "github.com/refraction-networking/utls"
)

var (
	port        = flag.Int("port", 9150, "Listen port")
	fingerprint = flag.String("fingerprint", "chrome_auto", "TLS fingerprint: chrome_auto, chrome_120, firefox_auto, safari, random")
	verbose     = flag.Bool("verbose", false, "Verbose logging")
)

// Map fingerprint name to uTLS ClientHelloID
func getClientHelloID(name string) *utls.ClientHelloID {
	switch strings.ToLower(name) {
	case "chrome_auto":
		return &utls.HelloChrome_Auto
	case "chrome_120":
		return &utls.HelloChrome_120
	case "firefox_auto":
		return &utls.HelloFirefox_Auto
	case "firefox_120":
		return &utls.HelloFirefox_120
	case "safari":
		return &utls.HelloSafari_Auto
	case "random":
		return &utls.HelloRandomized
	default:
		return &utls.HelloChrome_Auto
	}
}

func handleConnect(w http.ResponseWriter, r *http.Request) {
	if *verbose {
		log.Printf("[CONNECT] %s", r.Host)
	}

	// Establish TCP connection to target
	targetConn, err := net.DialTimeout("tcp", r.Host, 10*time.Second)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to connect: %v", err), http.StatusBadGateway)
		return
	}

	// Perform uTLS handshake
	host := strings.Split(r.Host, ":")[0]
	helloID := getClientHelloID(*fingerprint)

	tlsConn := utls.UClient(targetConn, &utls.Config{
		ServerName:         host,
		InsecureSkipVerify: false,
		NextProtos:         []string{"h2", "http/1.1"},
	}, *helloID)

	if err := tlsConn.Handshake(); err != nil {
		targetConn.Close()
		http.Error(w, fmt.Sprintf("TLS handshake failed: %v", err), http.StatusBadGateway)
		return
	}

	// Hijack the client connection
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		tlsConn.Close()
		http.Error(w, "Hijacking not supported", http.StatusInternalServerError)
		return
	}

	clientConn, _, err := hijacker.Hijack()
	if err != nil {
		tlsConn.Close()
		http.Error(w, fmt.Sprintf("Hijack failed: %v", err), http.StatusInternalServerError)
		return
	}

	// Send 200 Connection Established
	clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))

	// Bidirectional copy
	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		io.Copy(tlsConn, clientConn)
		tlsConn.Close()
	}()

	go func() {
		defer wg.Done()
		io.Copy(clientConn, tlsConn)
		clientConn.Close()
	}()

	wg.Wait()
}

func handleHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		handleConnect(w, r)
		return
	}

	// Forward non-CONNECT requests (plain HTTP proxy)
	if *verbose {
		log.Printf("[HTTP] %s %s", r.Method, r.URL)
	}

	// Strip proxy-detection headers
	r.Header.Del("X-Forwarded-For")
	r.Header.Del("Via")
	r.Header.Del("Proxy-Connection")
	r.Header.Del("Proxy-Authorization")

	client := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: false},
		},
		Timeout: 30 * time.Second,
	}

	resp, err := client.Do(r)
	if err != nil {
		http.Error(w, fmt.Sprintf("Request failed: %v", err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Copy response headers
	for k, vv := range resp.Header {
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

func main() {
	flag.Parse()

	addr := fmt.Sprintf("127.0.0.1:%d", *port)
	log.Printf("TLS Sidecar starting on %s (fingerprint: %s)", addr, *fingerprint)

	server := &http.Server{
		Addr:         addr,
		Handler:      http.HandlerFunc(handleHTTP),
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
