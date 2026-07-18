<!-- 文档分类: DEPLOY-MAN-012 | 阶段: 部署 | 原路径: docs/指南/pip发布后-github发布手册.md -->
# pip 发布后:外网机 `pip install` → 还原真实源码 → 推送 GitHub

> 真实场景:**内网机只能 `pip` 发布(`twine` → PyPI)、上不了 GitHub;外网机只能 `pip install`
> (没有仓库 checkout、没有 git bundle、不能直连内网 GitLab),但能上 github.com。**
>
> 桥梁就是 **PyPI 本身**:khy OS 的 pip 包里**内嵌了完整真实源码的加密快照**。
> 外网机 `pip install` 之后,用 `khy restore` 把源码还原出来,再 `git init` + push 到 GitHub。

适用版本:0.1.94+ · 相关:[源码还原与手工发布](%5BDEPLOY-MAN-015%5D%20源码还原与手工发布.md)

---

## 0. 一句话原理 + 一个必须先知道的限制

**原理**:每次 pip 构建时,`makeSourceSnapshot.js` 会跑 `git archive HEAD`,把当时**所有被跟踪
的源文件**(原始目录布局)加密成 `_source/snapshot.json` 一起打进包。`khy restore` 免密解密还原。

**限制(务必先读)**:快照是 `git archive`,即**发布那一刻的源码树,不含 `.git`、没有提交历史**。
所以这条 PyPI 链路推到 GitHub 的是一个**单次快照提交**,不是原始的逐条 commit 历史。
快照头里记录了原始 commit SHA(还原时会打印 `commit xxxxxxxx`),可写进提交信息留痕。

| 你想要的 | 用哪条路 |
|----------|----------|
| **只要把当前版本的源码放上 GitHub**(绝大多数情况) | ✅ 本文档:`pip install` → `khy restore` → push |
| **要完整 git 提交历史** | ❌ pip 包做不到(无 `.git`)。改用 `git bundle` 摆渡,见本文 §5 |

---

## 1. 内网机:正常 pip 发布(你已会,只确认一点)

确认包里**真的带了源码快照**——否则外网机还原不出来。

```bash
cd /home/kodehu03/Khy-OS

# 正常发布(任选)
python -m build && twine check dist/* && twine upload dist/*
#   或:bash scripts/release/publish-dual.sh 0.1.95

# 自检:构建出的 wheel 里应包含 _source/snapshot.json
unzip -l dist/khy_os-0.1.94-py3-none-any.whl | grep _source/
#   能看到 _source/snapshot.json + 加密归档 → 快照已就绪
```

> 源码快照**免密**:`DEFAULT_SOURCE_SECRET` 已内嵌进构建,`khy restore` 自动解密,
> 外网机不需要任何密钥。(仅当还原**旧版本用自定义密钥加的快照**时才需 `--secret`。)

---

## 2. 外网机:`pip install`

```bash
# 装指定版本(和内网刚发的对齐),独立环境更干净
python -m venv ~/khy-venv && source ~/khy-venv/bin/activate   # 可选
pip install "khy-os==0.1.94"

khy --version        # 应输出 0.1.94,确认装对版本
```

> 只想拿源码、不想真正安装运行时,也可以只**下载**不安装:
> `pip download khy-os==0.1.94 --no-deps -d /tmp/whl`,再走 §3 的「方式 B / 回退」。

---

## 3. 外网机:还原真实源码

### 3.1 首选:`khy restore`(免密,一条命令)

```bash
khy restore --into ./khy-os-src
```

它会:在已安装环境里定位内嵌的 `_source/` 快照 → 免密解密 → 校验 → 按**原始目录布局**
解压到 `./khy-os-src`,并打印 `共 N 个文件 · commit xxxxxxxxxxxx · 目录布局原样`。
**记下这个 commit SHA**,§4 提交时写进去留痕。

### 3.2 回退 A:包里没有快照(旧包) → 从运行时负载重建

```bash
khy publish origin-code --out ./khy-os-src
#   旧的自定义密钥快照才需要:khy publish origin-code --secret <密钥> --out ./khy-os-src
```

### 3.3 回退 B:完全不用 khy 命令 → 直接解 sdist(最朴素)

sdist(`.tar.gz`)本身就是**原始源码布局**,解压即得:

```bash
pip download khy-os==0.1.94 --no-deps --no-binary :all: -d /tmp/src
tar -xzf /tmp/src/khy_os-*.tar.gz -C /tmp/src
mv /tmp/src/khy_os-0.1.94 ./khy-os-src      # 目录里就是 kernel/ services/ platform/ ...
```

> 三种方式还原出的都是**纯源码**:按纯净规则**不含** `node_modules` / `site-packages` /
> `_build` / `target` 和原生二进制(`*.wasm` 例外)。这对「推 GitHub」毫无影响——这些本来
> 就在 `.gitignore` 里、不该进仓库。要**运行**才需自愈拉依赖(见 §6)。

---

## 4. 外网机:`git init` → 提交 → 推送 GitHub

还原出来的目录**没有 `.git`**,需要新建 git 仓库再推。

### 4.1 先准备 GitHub 鉴权(HTTPS push 必须)

```bash
# 推荐:GitHub CLI 登录(它会自动配好 git 凭证)
gh auth login          # 选 GitHub.com → HTTPS → 浏览器/Token 登录
# 或:用 PAT 配 credential helper / ~/.netrc(别把 token 写进 remote URL)
```

### 4.2 方式一(推荐):用内置 `khy publish git-push` 一把梭

进入还原目录,先 `git init` 建仓,再让内置命令处理 remote + 提交 + push:

```bash
cd ./khy-os-src
git init -b main

khy publish git-push \
  --repo acme/khy-os \          # owner/repo,也可给完整 URL
  --platform github \           # github | gitee | gitlab
  --auto-commit \               # 把还原的源码全量自动提交
  --commit-message "snapshot: khy-os v0.1.94 (origin commit <粘贴§3的SHA>)" \
  --set-upstream                # 首推建立 main 的上游
#   --ssh          用 SSH 地址(git@github.com:...)而非 HTTPS
#   --branch xxx   推到别的分支(默认当前分支/main)
#   --dry-run      只打印将执行的 git push,不真推
```

`git-push` 会:校验是 git 仓库 → 没 remote 就按 `--repo`+`--platform` 自动 `git remote add`
→ 有未提交改动且带 `--auto-commit` 就 `git add -A && git commit` → `git push [-u] <remote> <branch>`。
远程已存在且地址不同要改,需加 `--force-remote`。

### 4.3 方式二:纯手工 git(不依赖 khy 命令)

```bash
cd ./khy-os-src
git init -b main
git add -A
git commit -m "snapshot: khy-os v0.1.94 (origin commit <§3的SHA>)"
git remote add origin https://github.com/acme/khy-os.git
git push -u origin main
#   覆盖远端已有内容(确认要覆盖再用):git push -u origin main --force-with-lease
```

> 若 GitHub 上该仓库已有历史,而你推的是单快照,默认 push 会因非快进被拒。
> 确认要用快照覆盖,再用 `--force-with-lease`;**否则别强推**,先确认覆盖的是什么。

---

## 5. 需要「完整提交历史」时:git bundle 摆渡(pip 链路替代)

pip 包不含 `.git`,拿不到逐条历史。要**带历史**推 GitHub,只能在**有仓库的内网机**打 bundle:

```bash
# 内网机(有 .git 的真仓库里)
git bundle create khy-os.bundle --all          # 或只要 main 和 tag: main v0.1.94
git bundle verify khy-os.bundle
#   把 khy-os.bundle 用 U盘 / scp 拷到外网机

# 外网机
git clone khy-os.bundle khy-os && cd khy-os    # 带完整历史
git remote set-url origin https://github.com/acme/khy-os.git
git push origin main --tags                    # 历史 + tag 一起上
```

> 即只要历史就走 bundle,只要源码就走 pip(§2–§4)。两者互不依赖。

---

## 6. (可选)推完之后,让还原的源码能跑起来

还原是纯源码,运行前要触发自愈拉运行依赖:

```bash
cd ./khy-os-src
khy postinstall        # 拉 Node 运行时依赖(等价 run_postinstall)
khy dev-setup          # 补 Python dev 工具 + 检测 C/MoonBit 工具链
# 或仓库根直接:npm install
```

自愈遵守「永不中断」:依赖拉取失败会被 catch、打印可手动复制的恢复命令、并返回 0。

---

## 7. TL;DR

```
[内网机] twine upload  ──► PyPI(包内嵌 _source 加密源码快照)
                              │
[外网机] pip install khy-os==X.Y.Z
         khy restore --into ./khy-os-src      # 免密还原真实源码(无 .git)
         cd khy-os-src && git init -b main
         khy publish git-push --repo acme/khy-os --platform github --auto-commit --set-upstream
                              │
                         github.com ✓(单快照提交,头里记录原始 commit SHA)

要完整历史? → 内网机 git bundle 摆渡(§5),不走 pip。
```

---

## 8. 常见坑

1. **以为推上去带历史**:pip 链路是 `git archive` 快照,**没有历史**,只有一个 commit。要历史走 §5。
2. **`khy restore` 报「未找到快照」**:包太旧没内嵌快照 → 用 §3.2 `khy publish origin-code` 或 §3.3 解 sdist。
3. **push 报鉴权失败**:HTTPS push 要先 `gh auth login` 或配 credential helper;别把 PAT 明文写进 remote URL。
4. **push 被拒(non-fast-forward)**:GitHub 上已有历史而你推快照 → 想清楚再 `--force-with-lease`,别盲目强推。
5. **还原目录没有 `node_modules` 跑不起来**:纯净规则使然,`khy postinstall && khy dev-setup` 自愈(§6)。
6. **版本对不上**:`pip install` 时显式钉版本 `khy-os==X.Y.Z`,和内网发布版本一致;`khy --version` 复核。
