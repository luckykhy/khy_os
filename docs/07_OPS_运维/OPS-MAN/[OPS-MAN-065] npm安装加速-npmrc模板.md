# [OPS-MAN-065] npm 安装加速 .npmrc 模板（国内镜像）

面向已通过 npm 渠道安装 `@khy-os/khy-os` 的用户。国内网络直连
`registry.npmjs.org` 常常很慢，可用镜像加速下载，同时仍从官方 registry
拉取 `@khy-os` 作用域包（镜像同步有延迟，作用域包固定走官方最稳）。

## 用法

把下面内容保存为用户目录下的 `~/.npmrc`（Windows 为
`C:\Users\<你>\.npmrc`）。已有 `~/.npmrc` 的话，追加这几行即可。

```ini
# 默认走国内镜像加速普通依赖下载
registry=https://registry.npmmirror.com/

# @khy-os 作用域固定走官方 registry（镜像同步有延迟，保证拿到最新版）
@khy-os:registry=https://registry.npmjs.org/
```

保存后安装/升级：

```bash
npm install -g @khy-os/khy-os
# 或升级
npm update -g @khy-os/khy-os
```

## 验证

```bash
npm config get registry            # 应为 https://registry.npmmirror.com/
npm view @khy-os/khy-os version    # 应能取到最新版本号
khy --version
```

## 说明

- 这份 `~/.npmrc` 只影响**下载来源**，不含任何令牌，可放心保存。
- 发布方 `.npmrc`（仓库内 `packaging/npm/.npmrc`）与本模板无关，令牌只在
  发布时经环境变量 `NPM_TOKEN` 注入，绝不写入磁盘或提交仓库。
- 若你同时用 pip 和 npm 安装了 khy，见自检的「双渠道安装」告警：
  `khy doctor` 会指出哪个是当前生效副本、哪个被 PATH 遮蔽，并给出清理命令。
