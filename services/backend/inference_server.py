#!/usr/bin/env python3
# @pattern Template Method
"""
KHY-Quant Local Inference Server

Lightweight HTTP server wrapping llama-cpp-python for GGUF model inference.
Exposes an OpenAI-compatible /v1/chat/completions endpoint.

Usage:
  python3 inference_server.py                          # Default model path
  python3 inference_server.py --model ./models/qwen3.5-4b.gguf --port 8765

Requirements:
  pip install llama-cpp-python

Note: Qwen 3.5 requires llama-cpp-python >= 0.3.23 (with latest llama.cpp).
      If your version is too old, rebuild from source:
      CMAKE_ARGS="-DLLAMA_BLAS=ON" pip install llama-cpp-python --force-reinstall --no-cache-dir
"""
import argparse
import json
import os
import sys
import time
import uuid
import threading
import signal
from http.server import HTTPServer, BaseHTTPRequestHandler

DEFAULT_MODEL_PATH = os.environ.get(
    'LOCAL_MODEL_PATH',
    os.path.join(os.path.dirname(__file__), 'models', 'qwen3.5-4b.gguf')
)
DEFAULT_PORT = int(os.environ.get('INFERENCE_SERVER_PORT', '8765'))
DEFAULT_CTX = int(os.environ.get('INFERENCE_CTX_SIZE', '4096'))
MAX_CONTENT_LENGTH = 1 * 1024 * 1024  # 1MB max request body
INFERENCE_TIMEOUT_S = 120  # Max inference time per request

_llm = None
_llm_lock = threading.Lock()


def get_model():
    """Lazy-load model singleton."""
    global _llm
    if _llm is not None:
        return _llm

    with _llm_lock:
        if _llm is not None:
            return _llm

        try:
            from llama_cpp import Llama
        except ImportError:
            print("ERROR: llama-cpp-python not installed. Run: pip install llama-cpp-python", file=sys.stderr)
            sys.exit(1)

        model_path = DEFAULT_MODEL_PATH
        if not os.path.exists(model_path):
            print(f"ERROR: Model file not found: {model_path}", file=sys.stderr)
            sys.exit(1)

        print(f"Loading model: {model_path} (ctx={DEFAULT_CTX})...")
        _llm = Llama(
            model_path=model_path,
            n_ctx=DEFAULT_CTX,
            n_gpu_layers=0,  # CPU only
            n_threads=os.cpu_count() or 4,
            verbose=False,
        )
        print("Model loaded successfully.")
        return _llm


class InferenceHandler(BaseHTTPRequestHandler):
    """Handle OpenAI-compatible chat completions."""

    def log_message(self, format, *args):
        """Suppress default access log noise."""
        pass

    def _send_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health' or self.path == '/':
            self._send_json(200, {
                'status': 'ok',
                'model': os.path.basename(DEFAULT_MODEL_PATH),
                'loaded': _llm is not None,
            })
        elif self.path == '/v1/models':
            self._send_json(200, {
                'data': [{
                    'id': 'qwen3.5:4b',
                    'object': 'model',
                    'owned_by': 'local',
                }]
            })
        else:
            self._send_json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/v1/chat/completions':
            self._send_json(404, {'error': 'not found'})
            return

        try:
            content_length = int(self.headers.get('Content-Length', 0))
            if content_length > MAX_CONTENT_LENGTH:
                self._send_json(413, {'error': f'request body too large (max {MAX_CONTENT_LENGTH} bytes)'})
                return
            body = json.loads(self.rfile.read(content_length))
        except (json.JSONDecodeError, ValueError) as e:
            self._send_json(400, {'error': f'invalid JSON: {e}'})
            return

        messages = body.get('messages', [])
        temperature = body.get('temperature', 0.1)
        top_p = body.get('top_p', 0.85)
        max_tokens = body.get('max_tokens', 2048)

        try:
            llm = get_model()
            t0 = time.time()

            # Run inference with timeout via signal alarm
            def _timeout_handler(signum, frame):
                raise TimeoutError(f'Inference exceeded {INFERENCE_TIMEOUT_S}s limit')

            old_handler = signal.signal(signal.SIGALRM, _timeout_handler)
            signal.alarm(INFERENCE_TIMEOUT_S)
            try:
                result = llm.create_chat_completion(
                    messages=messages,
                    temperature=temperature,
                    top_p=top_p,
                    max_tokens=max_tokens,
                )
            finally:
                signal.alarm(0)
                signal.signal(signal.SIGALRM, old_handler)

            elapsed = time.time() - t0

            response = {
                'id': f'chatcmpl-{uuid.uuid4().hex[:12]}',
                'object': 'chat.completion',
                'created': int(time.time()),
                'model': 'qwen3.5:4b',
                'choices': result.get('choices', []),
                'usage': result.get('usage', {}),
                'elapsed_ms': int(elapsed * 1000),
            }
            self._send_json(200, response)
        except TimeoutError as e:
            self._send_json(504, {'error': str(e)})
        except Exception as e:
            self._send_json(500, {'error': str(e)})


def main():
    global DEFAULT_MODEL_PATH, DEFAULT_PORT, DEFAULT_CTX

    parser = argparse.ArgumentParser(description='KHY-Quant Local Inference Server')
    parser.add_argument('--model', default=DEFAULT_MODEL_PATH, help='Path to GGUF model file')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT, help='Server port')
    parser.add_argument('--ctx', type=int, default=DEFAULT_CTX, help='Context size')
    parser.add_argument('--preload', action='store_true', help='Load model on startup')
    args = parser.parse_args()

    DEFAULT_MODEL_PATH = args.model
    DEFAULT_CTX = args.ctx

    if args.preload:
        get_model()

    server = HTTPServer(('127.0.0.1', args.port), InferenceHandler)
    print(f"KHY Inference Server running on http://127.0.0.1:{args.port}")
    print(f"Model: {args.model}")
    print(f"Endpoints: GET /health, POST /v1/chat/completions")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()


if __name__ == '__main__':
    main()
