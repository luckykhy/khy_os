'use strict';

/**
 * Offline Knowledge Base — works without network or AI model.
 *
 * Provides:
 *   - Unit conversion (length, weight, temperature, area, volume, data storage)
 *   - Programming cheat sheets (git, vim, docker, regex, linux, http-status)
 *   - Common knowledge (capitals, provinces, elements, timezones)
 *   - HTTP status code reference
 *   - Regex helpers (email, phone, URL, IP patterns)
 *   - English-Chinese dictionary (200+ high-frequency terms for snippet translation)
 */

// ═══════════════════════════════════════════════════════════════════
// 1. English-Chinese Dictionary (for _translateSnippets)
// ═══════════════════════════════════════════════════════════════════

const EN_ZH_DICT = {
  // Weather & Nature
  weather: '天气', temperature: '温度', forecast: '预报', rain: '降雨', snow: '下雪',
  sunny: '晴天', cloudy: '多云', wind: '风', humidity: '湿度', storm: '暴风雨',
  clear: '晴朗', fog: '雾', thunder: '雷', celsius: '摄氏度', fahrenheit: '华氏度',
  sunrise: '日出', sunset: '日落', degree: '度', degrees: '度',

  // Finance & Economy
  price: '价格', rate: '汇率', exchange: '兑换', currency: '货币', market: '市场',
  stock: '股票', bitcoin: '比特币', ethereum: '以太坊', crypto: '加密货币',
  dollar: '美元', yuan: '人民币', euro: '欧元', yen: '日元', pound: '英镑',
  increase: '上涨', decrease: '下跌', change: '变化', trading: '交易',
  investment: '投资', profit: '利润', loss: '亏损', volume: '交易量',

  // Technology & Programming
  server: '服务器', database: '数据库', network: '网络', cloud: '云', api: '接口',
  error: '错误', warning: '警告', debug: '调试', code: '代码', file: '文件',
  function: '函数', variable: '变量', string: '字符串', array: '数组', object: '对象',
  class: '类', method: '方法', interface: '接口', type: '类型', module: '模块',
  import: '导入', export: '导出', install: '安装', update: '更新', delete: '删除',
  create: '创建', read: '读取', write: '写入', search: '搜索', download: '下载',
  upload: '上传', request: '请求', response: '响应', timeout: '超时', connection: '连接',
  performance: '性能', memory: '内存', cache: '缓存', process: '进程', thread: '线程',
  compile: '编译', build: '构建', deploy: '部署', test: '测试', version: '版本',
  repository: '仓库', branch: '分支', commit: '提交', merge: '合并', conflict: '冲突',
  dependency: '依赖', package: '包', library: '库', framework: '框架', plugin: '插件',
  authentication: '认证', authorization: '授权', token: '令牌', encrypt: '加密',
  decrypt: '解密', secure: '安全', vulnerability: '漏洞', permission: '权限',
  container: '容器', image: '镜像', port: '端口', proxy: '代理', load: '负载',
  config: '配置', configuration: '配置', setting: '设置', option: '选项',
  command: '命令', argument: '参数', parameter: '参数', flag: '标志',
  input: '输入', output: '输出', log: '日志', monitor: '监控', status: '状态',
  available: '可用', unavailable: '不可用', enabled: '已启用', disabled: '已禁用',
  success: '成功', failed: '失败', failure: '失败', pending: '等待中',
  running: '运行中', stopped: '已停止', restart: '重启',

  // Common
  result: '结果', results: '结果', information: '信息', data: '数据',
  today: '今天', tomorrow: '明天', yesterday: '昨天', current: '当前',
  about: '关于', example: '示例', description: '描述', name: '名称',
  list: '列表', total: '总计', count: '数量', number: '数字',
  source: '来源', latest: '最新', popular: '热门', official: '官方',
  free: '免费', open: '开源', public: '公共', private: '私有',
  country: '国家', city: '城市', region: '地区', language: '语言',
  time: '时间', date: '日期', year: '年', month: '月', day: '天',
  hour: '小时', minute: '分钟', second: '秒', week: '周',
  holiday: '假日', festival: '节日', event: '事件',
  user: '用户', admin: '管理员', system: '系统', application: '应用',
  feature: '功能', support: '支持', help: '帮助', guide: '指南',
  issue: '问题', solution: '解决方案', answer: '答案', question: '问题',
  recommend: '推荐', suggestion: '建议', tip: '提示', note: '注意',
  maximum: '最大', minimum: '最小', average: '平均', default: '默认',
  height: '高度', width: '宽度', size: '大小', weight: '重量',
  distance: '距离', speed: '速度', area: '面积',
};

// ═══════════════════════════════════════════════════════════════════
// 2. Unit Conversion
// ═══════════════════════════════════════════════════════════════════

const _UNIT_CONVERSIONS = {
  // Length
  '英里|mile': { to: '公里/km', factor: 1.60934, category: '长度' },
  '公里|km|千米': { to: '英里/mile', factor: 1 / 1.60934, category: '长度' },
  '英尺|foot|feet|ft': { to: '米/m', factor: 0.3048, category: '长度' },
  '米|m|公尺': { to: '英尺/ft', factor: 3.28084, category: '长度' },
  '英寸|inch|in': { to: '厘米/cm', factor: 2.54, category: '长度' },
  '厘米|cm': { to: '英寸/inch', factor: 1 / 2.54, category: '长度' },
  '码|yard|yd': { to: '米/m', factor: 0.9144, category: '长度' },
  '海里|nautical mile|nmi': { to: '公里/km', factor: 1.852, category: '长度' },

  // Weight
  '磅|pound|lb|lbs': { to: '千克/kg', factor: 0.453592, category: '重量' },
  '千克|kg|公斤': { to: '磅/lb', factor: 2.20462, category: '重量' },
  '盎司|ounce|oz': { to: '克/g', factor: 28.3495, category: '重量' },
  '克|g|公克': { to: '盎司/oz', factor: 1 / 28.3495, category: '重量' },
  '吨|ton|t': { to: '千克/kg', factor: 1000, category: '重量' },
  '斤': { to: '千克/kg', factor: 0.5, category: '重量' },
  '两': { to: '克/g', factor: 50, category: '重量' },

  // Area
  '平方英里|sq mile': { to: '平方公里/km²', factor: 2.58999, category: '面积' },
  '英亩|acre': { to: '平方米/m²', factor: 4046.86, category: '面积' },
  '公顷|hectare|ha': { to: '亩', factor: 15, category: '面积' },
  '亩|mu': { to: '平方米/m²', factor: 666.667, category: '面积' },

  // Volume
  '加仑|gallon|gal': { to: '升/L', factor: 3.78541, category: '体积' },
  '升|liter|l|litre': { to: '加仑/gal', factor: 1 / 3.78541, category: '体积' },
  '盎司液|fl oz|fluid ounce': { to: '毫升/mL', factor: 29.5735, category: '体积' },

  // Data storage
  'tb|terabyte': { to: 'GB', factor: 1024, category: '数据' },
  'gb|gigabyte': { to: 'MB', factor: 1024, category: '数据' },
  'mb|megabyte': { to: 'KB', factor: 1024, category: '数据' },
  'kb|kilobyte': { to: 'Byte', factor: 1024, category: '数据' },
};

// Temperature handled separately (non-linear)
const _TEMP_CONVERSIONS = {
  '华氏|fahrenheit|°f': (v) => ({ result: ((v - 32) * 5 / 9).toFixed(1), to: '摄氏度/°C' }),
  '摄氏|celsius|°c': (v) => ({ result: (v * 9 / 5 + 32).toFixed(1), to: '华氏度/°F' }),
};

// Unit-conversion patterns. The leading numeric quantifier is bounded to
// `\d{1,15}` (a 15-digit value covers every real conversion; longer is not a
// meaningful magnitude) to prevent a ReDoS: the original unbounded `\d+` head
// backtracked at every start position when the trailing `等于/换算…` anchor
// failed, giving O(n^2). `unitConvert` has no internal length cap and is called
// with model-generated tool params (`toolCalling.js` unit_convert), so a huge
// digit run froze the turn (>25 s at 60k digits). The bound is byte-identical on
// every realistic input (verified) — this is a pure-leaf so no env gate is read.
const _UNIT_CONVERT_RE = /(\d{1,15}(?:\.\d{1,15})?)\s*(?:个)?\s*(.{1,12})\s*(?:等于|是|换算|=|转|转换|换成?|兑)\s*(?:多少)?\s*(.{0,8})/i;
const _UNIT_CONVERT_RE2 = /(\d{1,15}(?:\.\d{1,15})?)\s*(.{1,12})\s*(?:等于多少|是多少|换算)/i;

function unitConvert(query) {
  const text = String(query || '').trim();
  let match = text.match(_UNIT_CONVERT_RE) || text.match(_UNIT_CONVERT_RE2);
  if (!match) return null;

  const value = parseFloat(match[1]);
  const fromUnit = match[2].trim().toLowerCase();
  if (isNaN(value)) return null;

  // Temperature
  for (const [pattern, fn] of Object.entries(_TEMP_CONVERSIONS)) {
    if (new RegExp(pattern, 'i').test(fromUnit)) {
      const r = fn(value);
      return `${value} ${fromUnit} = ${r.result} ${r.to}`;
    }
  }

  // Linear conversions
  for (const [pattern, conv] of Object.entries(_UNIT_CONVERSIONS)) {
    if (new RegExp(pattern, 'i').test(fromUnit)) {
      const result = (value * conv.factor).toFixed(4).replace(/\.?0+$/, '');
      return `${value} ${fromUnit} = ${result} ${conv.to}\n(${conv.category}换算)`;
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════
// 3. HTTP Status Codes
// ═══════════════════════════════════════════════════════════════════

const _HTTP_STATUS = {
  100: ['Continue', '继续 — 客户端应继续发送请求'],
  101: ['Switching Protocols', '切换协议 — 服务器正在切换到客户端请求的协议'],
  200: ['OK', '成功 — 请求已成功处理'],
  201: ['Created', '已创建 — 请求已成功，并创建了新资源'],
  204: ['No Content', '无内容 — 请求成功但无返回内容'],
  301: ['Moved Permanently', '永久重定向 — 资源已永久移动到新 URL'],
  302: ['Found', '临时重定向 — 资源临时移动到新 URL'],
  304: ['Not Modified', '未修改 — 资源未改变，可使用缓存'],
  307: ['Temporary Redirect', '临时重定向 — 同 302 但保持请求方法不变'],
  308: ['Permanent Redirect', '永久重定向 — 同 301 但保持请求方法不变'],
  400: ['Bad Request', '错误请求 — 请求语法错误，服务器无法理解'],
  401: ['Unauthorized', '未授权 — 需要身份认证'],
  403: ['Forbidden', '禁止 — 服务器拒绝执行此请求'],
  404: ['Not Found', '未找到 — 请求的资源不存在'],
  405: ['Method Not Allowed', '方法不允许 — HTTP 方法不被允许'],
  408: ['Request Timeout', '请求超时 — 服务器等待请求超时'],
  409: ['Conflict', '冲突 — 请求与当前资源状态冲突'],
  413: ['Payload Too Large', '负载过大 — 请求体超过服务器限制'],
  415: ['Unsupported Media Type', '不支持的媒体类型'],
  422: ['Unprocessable Entity', '无法处理 — 请求格式正确但语义错误'],
  429: ['Too Many Requests', '请求过多 — 超过速率限制'],
  500: ['Internal Server Error', '服务器内部错误'],
  502: ['Bad Gateway', '网关错误 — 上游服务器返回无效响应'],
  503: ['Service Unavailable', '服务不可用 — 服务器暂时过载或维护'],
  504: ['Gateway Timeout', '网关超时 — 上游服务器未及时响应'],
};

function httpStatus(query) {
  const text = String(query || '').trim();
  const codeMatch = text.match(/(\d{3})/);
  if (!codeMatch) {
    // List common codes
    const lines = ['常用 HTTP 状态码：\n'];
    for (const [code, [name, desc]] of Object.entries(_HTTP_STATUS)) {
      lines.push(`  ${code}  ${name} — ${desc}`);
    }
    return lines.join('\n');
  }
  const code = parseInt(codeMatch[1], 10);
  const entry = _HTTP_STATUS[code];
  if (entry) return `HTTP ${code} ${entry[0]}\n${entry[1]}`;
  // Unknown code, give category hint
  const cat = code >= 500 ? '服务器错误' : code >= 400 ? '客户端错误' : code >= 300 ? '重定向' : code >= 200 ? '成功' : '信息';
  return `HTTP ${code} — 非标准状态码 (${cat}类)`;
}

// ═══════════════════════════════════════════════════════════════════
// 4. Regex Helpers
// ═══════════════════════════════════════════════════════════════════

const _REGEX_PATTERNS = {
  '邮箱|email': { pattern: '/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$/', desc: '匹配电子邮箱地址', example: 'user@example.com' },
  '手机|phone|电话': { pattern: '/^1[3-9]\\d{9}$/', desc: '匹配中国大陆手机号 (11位)', example: '13812345678' },
  'url|网址|链接': { pattern: '/^https?:\\/\\/[\\w.-]+(?:\\.[\\w.-]+)+[\\w.,@?^=%&:/~+#-]*$/', desc: '匹配 HTTP/HTTPS URL', example: 'https://example.com/path' },
  'ip|IP地址': { pattern: '/^(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)$/', desc: '匹配 IPv4 地址', example: '192.168.1.1' },
  '身份证|id card': { pattern: '/^[1-9]\\d{5}(?:19|20)\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{3}[\\dXx]$/', desc: '匹配中国大陆18位身份证号', example: '110101199001011234' },
  '日期|date': { pattern: '/^\\d{4}[-/](?:0[1-9]|1[0-2])[-/](?:0[1-9]|[12]\\d|3[01])$/', desc: '匹配 YYYY-MM-DD 日期格式', example: '2026-05-30' },
  '十六进制|hex|颜色': { pattern: '/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/', desc: '匹配十六进制颜色值', example: '#FF5733' },
  '中文|chinese': { pattern: '/[\\u4e00-\\u9fff]+/', desc: '匹配中文字符', example: '你好世界' },
};

function regexHelper(query) {
  const text = String(query || '').trim().toLowerCase();

  for (const [keywords, info] of Object.entries(_REGEX_PATTERNS)) {
    if (new RegExp(keywords, 'i').test(text)) {
      return `${info.desc}\n\n  正则: ${info.pattern}\n  示例: ${info.example}`;
    }
  }

  // List all
  const lines = ['常用正则表达式：\n'];
  for (const [, info] of Object.entries(_REGEX_PATTERNS)) {
    lines.push(`  ${info.desc}`);
    lines.push(`    ${info.pattern}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// 5. Programming Cheat Sheets
// ═══════════════════════════════════════════════════════════════════

const _CHEAT_SHEETS = {
  git: `Git 常用命令速查：

  基础操作
    git init                    初始化仓库
    git clone <url>             克隆仓库
    git add <file>              暂存文件
    git add .                   暂存所有修改
    git commit -m "msg"         提交
    git status                  查看状态
    git log --oneline           查看简洁日志

  分支操作
    git branch                  列出分支
    git branch <name>           创建分支
    git checkout <branch>       切换分支
    git checkout -b <name>      创建并切换
    git merge <branch>          合并分支
    git rebase <branch>         变基

  远程操作
    git remote -v               查看远程仓库
    git push origin <branch>    推送
    git pull                    拉取并合并
    git fetch                   仅拉取不合并

  撤销操作
    git restore <file>          撤销工作区修改
    git restore --staged <f>    取消暂存
    git reset --soft HEAD~1     撤销最近提交(保留修改)
    git stash / git stash pop   暂存/恢复工作进度`,

  vim: `Vim 常用操作速查：

  模式切换
    i / a / o         进入插入模式 (光标前/后/下一行)
    Esc               返回普通模式
    v / V / Ctrl+v    可视/行可视/块可视模式
    :                 命令模式

  移动
    h j k l           左下上右
    w / b             下一个/上一个单词
    0 / $             行首/行尾
    gg / G            文件首/尾
    Ctrl+d / Ctrl+u   半页下/上

  编辑
    x / dd / dw       删除字符/行/单词
    yy / yw           复制行/单词
    p / P             粘贴到后/前
    u / Ctrl+r        撤销/重做
    . (dot)           重复上次操作
    ciw / ci"         修改单词/引号内容

  搜索替换
    /pattern          向下搜索
    ?pattern          向上搜索
    n / N             下一个/上一个匹配
    :%s/old/new/g     全局替换

  保存退出
    :w                保存
    :q / :q!          退出/强制退出
    :wq / ZZ          保存并退出`,

  docker: `Docker 常用命令速查：

  镜像
    docker images                 列出镜像
    docker pull <image>           拉取镜像
    docker build -t <tag> .       构建镜像
    docker rmi <image>            删除镜像

  容器
    docker run -d -p 8080:80 <img>  运行容器
    docker ps / docker ps -a        运行中/所有容器
    docker stop/start <id>          停止/启动
    docker rm <id>                  删除容器
    docker exec -it <id> bash       进入容器
    docker logs <id>                查看日志

  Docker Compose
    docker compose up -d          启动服务
    docker compose down           停止并移除
    docker compose logs -f        实时日志
    docker compose ps             服务状态

  清理
    docker system prune           清理未使用资源
    docker volume prune           清理未使用卷`,

  linux: `Linux 常用命令速查：

  文件操作
    ls -la              列出文件(含隐藏)
    cd / pwd            切换/显示目录
    cp -r src dst       复制(递归)
    mv src dst          移动/重命名
    rm -rf dir          删除(递归强制)
    mkdir -p dir        创建目录(含父级)
    chmod 755 file      修改权限
    chown user:grp f    修改所有者

  文本处理
    cat / head / tail   查看文件
    grep -rn "pat" dir  搜索内容
    sed 's/old/new/g'   替换文本
    awk '{print $1}'    列处理
    wc -l file          行数统计
    sort / uniq         排序/去重

  进程管理
    ps aux              查看进程
    top / htop          实时监控
    kill -9 <pid>       强制终止
    nohup cmd &         后台运行

  网络
    curl -v url         HTTP 请求
    wget url            下载文件
    netstat -tlnp       查看端口
    ss -tlnp            查看端口(新)
    ping / traceroute   网络诊断

  磁盘
    df -h               磁盘使用
    du -sh dir          目录大小
    free -h             内存使用`,

  regex: `正则表达式速查：

  元字符
    .         任意字符(除换行)
    \\d \\D    数字 / 非数字
    \\w \\W    单词字符 / 非单词字符
    \\s \\S    空白 / 非空白
    \\b        单词边界

  量词
    *         0或多次
    +         1或多次
    ?         0或1次
    {n}       恰好n次
    {n,m}     n到m次
    *? +?     非贪婪模式

  分组与引用
    (...)     捕获组
    (?:...)   非捕获组
    (?=...)   正向前瞻
    (?!...)   负向前瞻
    \\1 \\2    反向引用

  字符类
    [abc]     匹配a/b/c之一
    [^abc]    不匹配a/b/c
    [a-z]     范围匹配
    [\\u4e00-\\u9fff]  中文字符

  锚点
    ^         行首
    $         行尾

  常用模式
    邮箱: [\\w.+-]+@[\\w-]+\\.[\\w.]+
    URL:  https?://[\\w.-]+(?:\\.[\\w]+)+[/\\w.-]*
    手机: 1[3-9]\\d{9}
    IP:   \\d{1,3}(?:\\.\\d{1,3}){3}`,

  npm: `npm 常用命令速查：

  包管理
    npm init -y              初始化项目
    npm install <pkg>        安装依赖
    npm install -D <pkg>     安装开发依赖
    npm uninstall <pkg>      卸载
    npm update               更新所有依赖
    npm outdated             查看过时依赖
    npm ls --depth=0         查看已安装包

  运行脚本
    npm run <script>         运行脚本
    npm start                运行 start 脚本
    npm test                 运行测试
    npx <cmd>                执行本地/远程包

  发布
    npm login                登录 npmjs
    npm publish              发布包
    npm version patch/minor/major  版本号递增

  配置
    npm config list          查看配置
    npm config set registry <url>  设置镜像源
    国内镜像: https://registry.npmmirror.com`,

  python: `Python 常用速查：

  虚拟环境
    python -m venv .venv     创建虚拟环境
    source .venv/bin/activate  激活 (Linux/Mac)
    .venv\\Scripts\\activate    激活 (Windows)
    deactivate               退出

  包管理
    pip install <pkg>        安装
    pip install -r req.txt   从文件安装
    pip freeze > req.txt     导出依赖
    pip list                 列出已安装

  常用语法
    f"Hello {name}"          f-string 格式化
    [x for x in lst if x>0]  列表推导式
    {k: v for k, v in d}    字典推导式
    with open(f) as fp:      上下文管理器
    try/except/finally       异常处理
    @decorator               装饰器
    *args, **kwargs          可变参数

  调试
    breakpoint()             设置断点
    python -m pdb script.py  调试模式
    import traceback         堆栈跟踪`,
};

const _CHEAT_RE = /(?:速查|cheat\s*sheet|常用命令|快捷键|命令大全|命令速查)\s*[：:]?\s*(.+)/i;
const _CHEAT_RE2 = /^(.+?)(?:速查|常用命令|快捷键|命令大全|命令列表|cheat|常用)$/i;

function cheatSheet(query) {
  const text = String(query || '').trim().toLowerCase();
  const match = text.match(_CHEAT_RE) || text.match(_CHEAT_RE2);
  const topic = match ? match[1].trim().toLowerCase() : text;

  for (const [key, content] of Object.entries(_CHEAT_SHEETS)) {
    if (topic.includes(key) || new RegExp(key, 'i').test(topic)) {
      return content;
    }
  }

  // List available cheat sheets
  const available = Object.keys(_CHEAT_SHEETS).join('、');
  return `可用的速查手册: ${available}\n\n示例: "git 速查" 或 "vim 常用命令"`;
}

// ═══════════════════════════════════════════════════════════════════
// 6. Common Knowledge
// ═══════════════════════════════════════════════════════════════════

const _PROVINCES = '中国有 23 个省、5 个自治区、4 个直辖市、2 个特别行政区，共 34 个省级行政区。\n\n' +
  '  直辖市: 北京、天津、上海、重庆\n' +
  '  特别行政区: 香港、澳门\n' +
  '  自治区: 内蒙古、广西、西藏、宁夏、新疆';

const _COMMON_KNOWLEDGE = [
  { match: /多少个?省|省级行政区|省份/i, answer: _PROVINCES },
  { match: /圆周率|pi|π/i, answer: '圆周率 π ≈ 3.14159265358979323846...\n\n记忆口诀: 山巅一寺一壶酒(3.14159) 尔乐苦煞吾(26535)' },
  { match: /光速/i, answer: '光速 c = 299,792,458 m/s ≈ 30万公里/秒\n\n光从地球到月球约需 1.3 秒\n光从太阳到地球约需 8 分 20 秒' },
  { match: /声速|音速/i, answer: '标准大气压下 15°C 声速 = 340.3 m/s ≈ 1,225 km/h\n\n马赫数 1 = 1 倍音速' },
  { match: /地球.*周长|赤道.*长/i, answer: '地球赤道周长 ≈ 40,075 km\n子午线周长 ≈ 40,008 km\n平均半径 ≈ 6,371 km' },
  { match: /水.*沸点|沸点.*水/i, answer: '纯水在标准大气压 (101.325 kPa) 下沸点为 100°C (212°F)\n海拔每升高 300m，沸点约降低 1°C' },
  { match: /绝对零度/i, answer: '绝对零度 = 0 K = -273.15°C = -459.67°F\n这是热力学温度的最低极限，理论上不可达到' },
  { match: /ascii/i, answer: 'ASCII 码表 (常用):\n\n  0-9: 48-57\n  A-Z: 65-90\n  a-z: 97-122\n  空格: 32  换行: 10  Tab: 9\n  !: 33  ": 34  #: 35  $: 36  %: 37\n  &: 38  (: 40  ): 41  *: 42  +: 43' },
  { match: /进制.*转换|转换.*进制|二进制|八进制|十六进制.*对照/i, answer: '进制对照表:\n\n  十进制  二进制    八进制  十六进制\n  0       0000      0       0\n  1       0001      1       1\n  8       1000      10      8\n  10      1010      12      A\n  15      1111      17      F\n  16      10000     20      10\n  255     11111111  377     FF\n\n转换方法:\n  二→十: 1010 = 1×8+0×4+1×2+0×1 = 10\n  十→二: 10 ÷ 2 逐次取余反序 = 1010' },
  { match: /时区|utc|gmt/i, answer: '常用时区:\n\n  UTC+8   中国标准时间 (CST/BJT)\n  UTC+9   日本/韩国标准时间 (JST/KST)\n  UTC+0   格林威治标准时间 (GMT/UTC)\n  UTC-5   美国东部时间 (EST)\n  UTC-8   美国太平洋时间 (PST)\n  UTC+1   中欧时间 (CET)\n  UTC+5:30 印度标准时间 (IST)' },
  { match: /端口|port.*常用|常用.*端口/i, answer: '常用端口号:\n\n  20/21   FTP (数据/控制)\n  22      SSH\n  23      Telnet\n  25      SMTP (邮件发送)\n  53      DNS\n  80      HTTP\n  110     POP3 (邮件接收)\n  143     IMAP (邮件接收)\n  443     HTTPS\n  3306    MySQL\n  3389    RDP (远程桌面)\n  5432    PostgreSQL\n  6379    Redis\n  8080    HTTP (备用)\n  27017   MongoDB' },
  { match: /chmod|权限.*数字|文件权限/i, answer: 'Linux 文件权限 chmod:\n\n  数字表示: r=4, w=2, x=1\n\n  755 = rwxr-xr-x  (所有者全权限,其他可读执行)\n  644 = rw-r--r--  (所有者读写,其他只读)\n  700 = rwx------  (仅所有者全权限)\n  777 = rwxrwxrwx  (所有人全权限,不推荐)\n  600 = rw-------  (仅所有者读写,私钥文件用)' },
];

function commonKnowledge(query) {
  const text = String(query || '').trim();
  for (const item of _COMMON_KNOWLEDGE) {
    if (item.match.test(text)) return item.answer;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// 7. Snippet Translation (English → Chinese)
// ═══════════════════════════════════════════════════════════════════

function translateSnippets(text) {
  if (!text || typeof text !== 'string') return text;

  // Skip if already mostly Chinese
  const chineseRatio = (text.match(/[\u4e00-\u9fff]/g) || []).length / text.length;
  if (chineseRatio > 0.3) return text;

  const words = text.split(/(\s+|[.,;:!?()\[\]{}'"<>\/\\|@#$%^&*+=~`—–-]+)/);
  let translated = false;
  const result = words.map(w => {
    const lower = w.toLowerCase().trim();
    if (EN_ZH_DICT[lower]) {
      translated = true;
      return EN_ZH_DICT[lower];
    }
    return w;
  });

  if (!translated) return text;
  return result.join('') + ' (机翻)';
}

// ═══════════════════════════════════════════════════════════════════
// 8. Unified Query Router
// ═══════════════════════════════════════════════════════════════════

const _OFFLINE_INTENT_RE = /换算|等于多少|convert|多少.*[里尺磅斤两吨]|英尺|英寸|英里|磅|华氏|摄氏|加仑|盎司|海里|公顷|亩/i;
const _CHEAT_INTENT_RE = /速查|cheat|常用命令|快捷键|命令大全|git\s*命令|vim\s*命令|docker\s*命令|linux\s*命令|npm\s*命令|python\s*命令|正则.*速查/i;
const _HTTP_STATUS_RE = /(?:http|状态码|status\s*code).*\d{3}|\d{3}\s*(?:状态码|status|错误码|error\s*code)|^(?:http\s*)?\d{3}$/i;
// 自然语言追问形:「404 是什么」「500是什么错误」「403什么意思」——一个**独立的** 3 位数
// (前后非数字,排除 1404/4040 之类长数误命中)直接跟通用追问后缀。此形被 _HTTP_STATUS_RE
// 的三种写法全部漏掉(无 http/状态码 前缀、无 状态码/错误码 后缀、非纯裸 3 位锚定)。
// 仅当该 3 位码确实落在 _HTTP_STATUS 表内才路由(detect 内二次校验),从而绝不把
// 「365 是什么」这类非状态码的 3 位数误判为 http_status。门控 KHY_HTTP_STATUS_NL。
const _HTTP_STATUS_NL_RE = /(?:^|[^\d])(\d{3})(?!\d)\s*(?:是什么意思|是什么错误|是什么状态|是什么情况|是什么|是啥|什么意思|啥意思|什么错误|什么状态|代表什么|表示什么|怎么回事|的含义|含义)/i;
const _REGEX_INTENT_RE = /正则|regex|邮箱正则|手机正则|身份证正则|url正则|ip正则|匹配.*正则|正则.*匹配/i;
const _KNOWLEDGE_INTENT_RE = /多少个?省|省份|圆周率|光速|声速|音速|赤道|沸点|绝对零度|ascii|进制.*转换|转换.*进制|时区|utc|gmt|常用端口|端口号|chmod|文件权限/i;

/**
 * 门控:KHY_HTTP_STATUS_NL 默认开;显式 0/false/off/no/空串 → 关。
 * 纯叶子契约——env 由调用方注入(localBrainService 传 process.env),本模块绝不直接读
 * process.env;不注入 env(undefined/null)→ 默认开(测试 / 旧调用方零摩擦)。
 */
function _httpStatusNlEnabled(env) {
  if (!env || env.KHY_HTTP_STATUS_NL == null) return true;
  const v = String(env.KHY_HTTP_STATUS_NL).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no' || v === '');
}

function detect(input, env) {
  const text = String(input || '').trim();
  if (!text) return null;

  if (_OFFLINE_INTENT_RE.test(text)) return { type: 'unit_convert', input: text };
  if (_HTTP_STATUS_RE.test(text)) return { type: 'http_status', input: text };
  // 自然语言追问形(门控关 → 跳过 → 字节回退到下方既有分支,与历史完全一致)。
  if (_httpStatusNlEnabled(env)) {
    const nlm = text.match(_HTTP_STATUS_NL_RE);
    if (nlm && _HTTP_STATUS[parseInt(nlm[1], 10)]) return { type: 'http_status', input: text };
  }
  if (_CHEAT_INTENT_RE.test(text)) return { type: 'cheat_sheet', input: text };
  if (_REGEX_INTENT_RE.test(text)) return { type: 'regex_helper', input: text };
  if (_KNOWLEDGE_INTENT_RE.test(text)) return { type: 'common_knowledge', input: text };
  return null;
}

function execute(plan) {
  if (!plan) return null;
  switch (plan.type) {
    case 'unit_convert': return unitConvert(plan.input);
    case 'http_status': return httpStatus(plan.input);
    case 'cheat_sheet': return cheatSheet(plan.input);
    case 'regex_helper': return regexHelper(plan.input);
    case 'common_knowledge': return commonKnowledge(plan.input);
    default: return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════

module.exports = {
  EN_ZH_DICT,
  unitConvert,
  httpStatus,
  regexHelper,
  cheatSheet,
  commonKnowledge,
  translateSnippets,
  detect,
  execute,
};
