import { computed, nextTick, ref } from 'vue'
import { ElMessage } from 'element-plus'
import axios from 'axios'
import QRCode from 'qrcode'

export function useDashboardLanAccess() {
  const lanIpAddress = ref('')
  const showQrCode = ref(false)
  const qrCodeCanvas = ref(null)

  const lanAccessUrl = computed(() => {
    if (!lanIpAddress.value) return ''

    const isDomain = !lanIpAddress.value.match(/^\d+\.\d+\.\d+\.\d+$/)
    if (isDomain) {
      return `http://${lanIpAddress.value}`
    }
    return `http://${lanIpAddress.value}:8080`
  })

  const getLanIpAddress = async () => {
    try {
      const currentHostname = window.location.hostname
      const currentPort = window.location.port || (window.location.protocol === 'https:' ? '443' : '80')
      void currentPort

      if (
        currentHostname &&
        !currentHostname.match(/^\d+\.\d+\.\d+\.\d+$/) &&
        currentHostname !== 'localhost'
      ) {
        lanIpAddress.value = currentHostname
        console.log('✅ 使用当前访问域名:', currentHostname)
        return
      }

      try {
        const response = await axios.get('/api/system/network-info')
        if (response.data && response.data.data && response.data.data.lanIp) {
          lanIpAddress.value = response.data.data.lanIp
          console.log('✅ 从后端获取局域网IP:', lanIpAddress.value)

          if (response.data.data.allCandidates) {
            console.log('📋 所有候选IP:', response.data.data.allCandidates)
          }
          return
        }
      } catch {
        console.log('⚠️ 后端API获取IP失败，尝试前端方法')
      }

      const pc = new RTCPeerConnection({ iceServers: [] })
      pc.createDataChannel('')

      pc.createOffer().then((offer) => pc.setLocalDescription(offer))

      const candidateIps = []

      pc.onicecandidate = (ice) => {
        if (!ice || !ice.candidate || !ice.candidate.candidate) return

        const ipRegex = /([0-9]{1,3}(\.[0-9]{1,3}){3})/
        const match = ipRegex.exec(ice.candidate.candidate)

        if (match && match[1]) {
          const ip = match[1]

          if (ip === '127.0.0.1' || ip.startsWith('169.254')) {
            return
          }

          let priority = 99
          if (ip.startsWith('192.168')) {
            priority = 1
          } else if (ip.startsWith('10.')) {
            priority = 2
          } else if (ip.startsWith('172.')) {
            const secondOctet = parseInt(ip.split('.')[1])
            if (secondOctet >= 16 && secondOctet <= 31) {
              priority = 3
            }
          }

          candidateIps.push({ ip, priority })
          console.log('🔍 WebRTC检测到IP:', ip, '优先级:', priority)
        }
      }

      setTimeout(() => {
        if (!lanIpAddress.value && candidateIps.length > 0) {
          candidateIps.sort((a, b) => a.priority - b.priority)
          lanIpAddress.value = candidateIps[0].ip
          console.log('✅ 通过WebRTC选择局域网IP:', lanIpAddress.value)
          console.log(
            '📋 所有候选IP:',
            candidateIps.map((c) => `${c.ip} (优先级${c.priority})`).join(', ')
          )
        }

        if (!lanIpAddress.value) {
          const hostname = window.location.hostname
          if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
            lanIpAddress.value = hostname
            console.log('✅ 使用hostname作为IP:', hostname)
          }
        }

        pc.close()
      }, 2000)
    } catch (error) {
      console.error('❌ 获取局域网IP失败:', error)
    }
  }

  const copyLanUrl = async () => {
    try {
      await navigator.clipboard.writeText(lanAccessUrl.value)
      ElMessage.success('已复制局域网访问地址')
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = lanAccessUrl.value
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      ElMessage.success('已复制局域网访问地址')
    }
  }

  const generateQrCode = async () => {
    if (!qrCodeCanvas.value || !lanAccessUrl.value) return

    try {
      await QRCode.toCanvas(qrCodeCanvas.value, lanAccessUrl.value, {
        width: 200,
        margin: 1,
        color: {
          dark: '#000000',
          light: '#ffffff'
        }
      })
      console.log('✅ 二维码生成成功')
    } catch (error) {
      console.error('❌ 二维码生成失败:', error)
      ElMessage.error('二维码生成失败')
    }
  }

  const toggleQrCode = async () => {
    showQrCode.value = !showQrCode.value
    if (showQrCode.value) {
      await nextTick()
      generateQrCode()
    }
  }

  return {
    lanIpAddress,
    lanAccessUrl,
    showQrCode,
    qrCodeCanvas,
    getLanIpAddress,
    copyLanUrl,
    toggleQrCode
  }
}
