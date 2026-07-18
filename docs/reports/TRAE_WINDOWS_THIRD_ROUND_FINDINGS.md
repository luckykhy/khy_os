# Trae Windows 端调查记录（第三轮）

## 背景

本记录整理了对 Trae Windows 客户端第三轮静态排查的结论，聚焦以下 3 个问题：

- `MAIN_TO_SANDBOX_SEND_USER_INFO` 到达 sandbox 后，`token` 被存放在何处
- `iCubeAuthInfo` / `userInfo.host` 与 `ugApi` 的真实基址选择逻辑
- Trae 是否向扩展侧暴露 `AuthenticationProvider` / `authentication.getSession()`

说明：

- 本轮结论主要来自安装包静态分析，而不是抓包或运行时注入。
- 实际安装路径为 `D:\Users\25789\AppData\Local\Programs\Trae`。
- 重点分析文件包括：
  - `resources\app\out\vs\workbench\workbench.desktop.main.js`
  - `resources\app\out\main.js`
  - `resources\app\product.json`

## 1. Sandbox 收到 `userInfo` 后 token 存在哪里

### 1.1 结论

- sandbox 接收 `MAIN_TO_SANDBOX_SEND_USER_INFO` 后，首先把完整 `userInfo` 放进 workbench 侧认证服务的内存变量。
- 就接收链本身看，没有发现 sandbox 把这份 IPC 收到的 `token` 直接写入本地文件、DB 或 `localStorage`。
- 但主进程确实会把完整 `userInfo` 持久化到本地存储中，供后续恢复登录态使用。
- 因此应区分两层：
  - `sandbox/workbench`：主要是内存持有
  - `main process`：存在本地持久化

### 1.2 Sandbox 接收链

在 `workbench.desktop.main.js` 中，sandbox/workbench 会注册 `MAIN_TO_SANDBOX_SEND_USER_INFO` 的监听。

接收到数据后，核心逻辑可概括为：

```js
O(e, t) {
  this.n = t;
  this.q.complete();
  this.r.fire(this.n);
  dispatchEvent(new CustomEvent("icube:user-profile-data-received", {
    detail: this.userInfoPayload
  }));
}
```

这里的关键点是：

- `this.n = t`：完整 `userInfo` 被放入 service 实例内存字段 `this.n`
- `this.r.fire(this.n)`：把完整对象向内部观察者广播
- 对 DOM 事件 `icube:user-profile-data-received`，只暴露裁剪后的 `userInfoPayload`

### 1.3 对外事件是否泄露 token

`userInfoPayload` 是一个裁剪后的对象，只包含以下非敏感字段：

- `avatarUrl`
- `username`
- `scope`
- `loginScope`
- `tenant_id`
- `tenant_name`
- `userId`
- `saasProductType`
- `roleId`
- `isInternet`

未发现 `token` / `refreshToken` 被放进这个 DOM 事件的 `detail` 中。

这说明：

- 浏览器侧自定义事件不是 token 的直接暴露面
- 但 workbench 内部 service 仍保留完整 `userInfo`

### 1.4 workbench 内存中的 session 形态

在同一个 `workbench.desktop.main.js` 中，Trae 注册了一个认证提供者实现，类名可还原为 `GGt`，其核心逻辑可概括为：

```js
j(i) {
  return {
    id: i.userId,
    accessToken: i.token,
    account: {
      ...i.account,
      id: i.userId,
      label: i.account.username
    },
    scopes: [],
    idToken: void 0
  };
}
```

这说明 sandbox/workbench 内部会把内存中的 `userInfo.token` 直接映射成 authentication session 的 `accessToken`。

因此从风险角度看：

- sandbox 不只是“看一眼后丢掉”
- 它会把 token 留在内存认证状态里，供后续 API / 扩展消费

### 1.5 是否写入 sandbox 本地文件 / DB

基于本轮静态分析，未看到 `MAIN_TO_SANDBOX_SEND_USER_INFO` 这条接收路径在 sandbox 侧直接执行以下动作：

- `localStorage.setItem(...)` 写入 token
- `storageService.store(...)` 写入 token
- 文件系统写入 token
- sqlite / leveldb 直写 token

所以对问题“sandbox 拿到 token 后是纯内存持有，还是写入某个可读文件/DB”而言，更准确的回答是：

- **sandbox 接收链本身：以内存持有为主**
- **不是在这条 workbench 接收逻辑里直接落文件**

### 1.6 但主进程存在持久化

需要特别补充：虽然 sandbox 接收链本身未见直接落盘，但主进程并不是纯内存。

在 `main.js` 的 `UserStorage` 相关逻辑中，可确认存在：

```js
async h(t) {
  if (this.persistedKey && t) {
    await this.k(t.userId, t.account.userTag);
    const e = JSON.stringify(t);
    const i = await u4(e);
    this.b.setItem(this.persistedKey, i);
  }
}
```

并且主进程会调用：

```js
async updateUserInfoStorage(t, e) {
  t ? await this.h(t) : e && await this.i();
}
```

这说明：

- 完整 `userInfo` 会被 `JSON.stringify(...)`
- 经 `u4(...)` 处理后写入存储
- 该存储是主进程使用的本地持久化层，不是 sandbox IPC 接收回调里的临时变量

结合第二轮结论，可以把这个持久化对象理解为 `iCubeAuthInfo` 登录态缓存。

### 1.7 本问题最终判断

- **若只问 sandbox 收到 IPC 后的直接落点**：是内存 service 字段与内存 session
- **若问整个 Trae 客户端是否会把这份 token 持久化**：会，由主进程写入本地存储
- **因此不能简单总结为“完全纯内存”**

## 2. `host` 字段典型值与 `ugApi` URL 选择

### 2.1 结论

- `userInfo.host` / `iCubeAuthInfo.host` 对应的是账号鉴权相关 API host，典型值不是 `core-normal`，而是 `grow-*` 域。
- 在当前 i18n 稳定版配置中，典型值主要是：
  - `https://grow-normal.trae.ai`
  - `https://growsg-normal.trae.ai`
  - `https://grow-normal.traeapi.us`
- `ugApi` 不是简单硬编码单一域名，而是从 boot config 中读取，再按区域选择对应基址后拼路径。
- `ugApi` 使用的也是 `grow-*` 域，但其 US 路由与 account host 逻辑并不完全相同。

### 2.2 `account.trae` 的真实配置

在 `product.json` 的 `bootConfig.account.trae` 中，可以直接看到账号相关 host：

```json
{
  "normal": "https://grow-normal.trae.ai",
  "SG": "https://growsg-normal.trae.ai",
  "US": "https://growsg-normal.trae.ai",
  "USTTP": "https://grow-normal.traeapi.us"
}
```

这说明对于登录态、refresh token、获取用户信息等账号链路，主域是 `grow-*` 而不是 `core-*`。

因此对“host 字段的典型值是什么”这个问题，可以回答为：

- **主流 i18n/海外包典型值是 `grow-normal.trae.ai` 一系**
- **SG/部分 US 逻辑会落到 `growsg-normal.trae.ai`**
- **USTTP 线路会落到 `grow-normal.traeapi.us`**

### 2.3 主进程如何按 `userInfo` 选择 account host

在 `main.js` 的账号 host 选择逻辑中，可还原为：

```js
setApiHostByUserInfo(t) {
  const e = this.m.bootConfig.account.trae;
  if (!t || this.a) return;
  if (this.m.provider === nr.YINLI) {
    this.a = e.normal;
    return;
  }
  const i = t?.account?.storeRegion;
  if (i === ft.USTTP && e.USTTP) {
    this.a = e.USTTP;
    return;
  }
  if ((i === ft.SG || i === ft.US) && e.SG) {
    this.a = e.SG;
    return;
  }
  if (i === ft.CN) {
    this.a = e.normal;
    return;
  }
  const r = R1(t);
  (r === ft.US || r === ft.SG) && e.SG ? this.apiHost = e.SG :
  r === ft.USTTP && e.USTTP ? this.apiHost = e.USTTP :
  this.apiHost = e.normal;
}
```

该逻辑说明：

- 首先看 `account.storeRegion`
- 其次退回到 `userRegion` / `aiRegion` 一类区域信息
- 最终在 `normal` / `SG` / `USTTP` 之间选 host

所以 `userInfo.host` 的典型值会跟着用户区域变化。

### 2.4 `ugApi` 的真实配置

在 `product.json` 的 `bootConfig.ug.trae` 中，可以直接看到 UG 域配置：

```json
{
  "normal": "https://grow-normal.trae.ai",
  "SG": "https://growsg-normal.trae.ai",
  "US": "https://growva-normal.trae.ai",
  "USTTP": "https://grow-normal.traeapi.us"
}
```

这里要注意：

- `ug.normal` 仍然是 `grow-normal.trae.ai`
- `ug.SG` 是 `growsg-normal.trae.ai`
- **`ug.US` 是 `growva-normal.trae.ai`**
- 这与 `account.trae.US` 使用 `growsg-normal.trae.ai` 并不一致

因此：

- `host` 字段与 `ugApi` 虽然都属于 `grow-*` 体系
- 但不能把两者完全等同

### 2.5 `ugApi` 是怎么拼出完整 URL 的

`main.js` 中的 `BootService.getApi(...)` 逻辑可概括为：

```js
async getApi(t, e) {
  const i = await this.getBootConfig();
  return t === Kc.iCubeApi ? this.y(`${i?.iCubeApi || ""}${e}`) :
         t === Kc.ugApi ? this.y(`${i?.ugApi || ""}${e}`) :
         t === Kc.iCubeAgentApi ? this.y(`${i?.iCubeAgentApi || ""}${e}`) :
         "";
}
```

也就是说：

1. 先从当前 boot config 里取 `ugApi`
2. 再把调用方给出的路径直接拼接到后面
3. 最后补成标准 URL

因此完整 URL 的拼法本质上是：

```text
<当前区域对应的 ugApi 基址> + <业务 path>
```

例如当前代码中的一个典型用法是：

```text
/trae/gtm/tob/api/v1/config/plan_attribute
```

如果当前 `ugApi` 解析为 `https://grow-normal.trae.ai`，则完整地址就是：

```text
https://grow-normal.trae.ai/trae/gtm/tob/api/v1/config/plan_attribute
```

### 2.6 `ugApi` 的区域选择逻辑

从 `main.js` 中 boot key 解析逻辑可以看出，Trae 会把 `trae` 域配置交给区域选择函数处理，大意为：

- i18n 包按上下文地区选择 `normal` / `SG` / `US` / `USTTP`
- 企业/业务账号可改走 `saasBootConfig.apiHost`
- 之后 `getApi(Kc.ugApi, path)` 只负责拼路径，不再重新判区

所以更完整的理解是：

- 区域判定发生在 boot config 解析阶段
- URL 拼接发生在 `getApi(...)` 阶段

### 2.7 本问题最终判断

- **`host` 字段的典型值：优先是 `grow-normal.trae.ai` / `growsg-normal.trae.ai` / `grow-normal.traeapi.us`**
- **`core-normal.trae.ai` 更偏 AI/agent/core 体系，不是这里的主账号 host**
- **`ugApi` 的完整 URL 由“当前解析出的 `ugApi` 基址 + path”组成**
- **US 路径下 `ugApi` 与 account host 可能不一致，需要分别看**

## 3. Trae 是否向扩展暴露 `authentication session`

### 3.1 结论

- 有。
- Trae 在 workbench 中注册了一个 `AuthenticationProvider`。
- provider id 为 `icube.marscode`，label 为 `MarsCode`。
- 扩展理论上可以通过标准 VS Code API `vscode.authentication.getSession("icube.marscode", [])` 获取 session。
- 返回的 `session.accessToken` 直接来自内存里的 `userInfo.token`。

### 3.2 注册点

在 `workbench.desktop.main.js` 中，可还原出如下实现：

```js
GGt = class extends O {
  static { this.id = "icube.marscode" }
  static { this.label = "MarsCode" }
  ...
}
```

随后注册逻辑大意为：

```js
const provider = new GGt(GGt.id, GGt.label, authService, commandService);
this.registerAuthenticationProvider(provider.id, provider);
```

这说明：

- Trae 不是只实现了内部 token service
- 它还把这套状态桥接到了 VS Code 标准认证框架里

### 3.3 session 的 access token 来源

provider 在构造 session 时，直接使用：

```js
accessToken: i.token
```

也就是说：

- `session.accessToken` 就是当前 `userInfo.token`
- 不是额外再交换出来的一层受限 token

### 3.4 扩展侧意味着什么

如果扩展宿主没有额外权限限制，并且该 provider 对扩展可见，那么扩展可以使用类似代码：

```ts
const session = await vscode.authentication.getSession("icube.marscode", []);
const token = session?.accessToken;
```

从静态代码看，这条能力链是成立的。

### 3.5 边界说明

本轮是静态分析，因此尚未额外验证：

- 是否所有扩展都能无提示访问该 provider
- 是否存在 manifest / trust / consent 层的额外限制
- 是否存在仅内置扩展可见的运行时策略

但至少可以确认：

- **Trae 内部确实注册了标准 `AuthenticationProvider`**
- **其 session token 源头就是 `userInfo.token`**

## 4. 最终汇总

### 4.1 关于 sandbox token 落点

- `MAIN_TO_SANDBOX_SEND_USER_INFO` 到达 sandbox 后，完整 `userInfo` 先进入 workbench 内存字段
- workbench 再把它映射为 authentication session
- 在这条接收路径里，未发现直接落文件/DB
- 但主进程存在本地持久化，因此整个客户端并非纯内存

### 4.2 关于 `host` / `ugApi`

- `host` 字段的典型值主要是 `grow-*` 域，不是 `core-*`
- `ugApi` 同样走 `grow-*` 体系，但 US 场景下域名选择和 account host 不完全相同
- 完整 URL 的形成方式是：**区域解析后的 `ugApi` 基址 + 业务路径**

### 4.3 关于扩展取 token

- Trae 已注册 `icube.marscode` 认证提供者
- provider 返回的 `accessToken` 就是 `userInfo.token`
- 因此从静态代码层面看，扩展侧具备通过标准 authentication API 触达该 token 的可能性

## 5. 建议后续验证

如果还要继续往下收敛风险面，建议下一步做 3 个运行态验证：

1. 在扩展宿主中最小化编写测试扩展，实际调用 `vscode.authentication.getSession("icube.marscode", [])`
2. 在用户目录下定位 Electron 本地存储目录，确认 `iCubeAuthInfo` 的真实落盘位置与可读性
3. 对 `grow-normal` / `growsg-normal` / `growva-normal` 三类域分别做调用链比对，确认各端点对应业务模块
