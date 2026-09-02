// khy.imagePicker —— 简单的"选图拿 dataUrl"工具
// 实现：弹一个隐藏的 <input type=file accept="image/*">，用户选完用 FileReader 转 dataUrl。
// Android WebView 上系统会自动调起相册/文件选择器（无新权限需求）。
// 限制：单图；dataUrl < 5MB（受 FileReader 内存约束，超大图会被压缩到最长边 1280）

const MAX_LONG_SIDE = 1280;
const JPEG_QUALITY = 80;

let inputEl = null;
let currentResolve = null;

function ensureInput() {
  if (inputEl) return inputEl;
  inputEl = document.createElement('input');
  inputEl.type = 'file';
  inputEl.accept = 'image/*';
  inputEl.style.position = 'fixed';
  inputEl.style.left = '-9999px';
  inputEl.style.top = '0';
  inputEl.style.opacity = '0';
  document.body.appendChild(inputEl);
  inputEl.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) {
      if (currentResolve) currentResolve(null);
      currentResolve = null;
      return;
    }
    readAndCompress(file)
      .then((dataUrl) => { if (currentResolve) currentResolve(dataUrl); currentResolve = null; })
      .catch((err) => { if (currentResolve) currentResolve({ error: err.message || String(err) }); currentResolve = null; });
    // 重置 value，下一次选同一张图也能触发 change
    inputEl.value = '';
  });
  return inputEl;
}

async function readAndCompress(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
  // 走一次 image + canvas 压缩
  return await compress(dataUrl);
}

async function compress(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.width;
        const h = img.height;
        if (Math.max(w, h) <= MAX_LONG_SIDE) { resolve(dataUrl); return; }
        const scale = MAX_LONG_SIDE / Math.max(w, h);
        const nw = Math.round(w * scale);
        const nh = Math.round(h * scale);
        const canvas = document.createElement('canvas');
        canvas.width = nw;
        canvas.height = nh;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, nw, nh);
        resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
      } catch (err) { reject(err); }
    };
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = dataUrl;
  });
}

export function pickImage() {
  ensureInput().click();
  return new Promise((resolve) => {
    currentResolve = resolve;
    // 5 分钟没选 → 当取消；避免工具循环永远阻塞（红线 3：避免无限等待主动操作）
    setTimeout(() => {
      if (currentResolve) { currentResolve(null); currentResolve = null; }
    }, 5 * 60 * 1000);
  });
}
