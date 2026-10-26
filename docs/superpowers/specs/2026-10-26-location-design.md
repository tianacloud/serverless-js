# 平台统一单次定位

用户已确认按此实施：实现归 serverless-js；平台注入 tiana.location；业务应用不识别环境、不传AppID；默认WGS-84，覆盖PC/WAP/微信H5及小程序WebView。AppID固定于服务端，SDK只消费同源公开签名响应。用户后续明确授权将SDK提交并推送到main；npm发布和此新平台能力部署尚未授权。

## Approaches
采用 SDK 实现 + Web/CLI 自动注入，复用 auth/files 模式，应用零环境配置。显式 import/初始化适合平台外消费者，底层工厂仍导出供平台使用；不要求托管应用初始化。服务端无法直接读取终端传感器，调用在终端执行。

## 接口与边界
- SDK导出 createTianaLocation({signingUrl?,sdkUrl?,entryUrl?})，不接收appid/密钥。配置由平台注入；构造和导入不加载微信或请求定位。
- tiana.location.getCurrentPosition({timeoutMs=20000,signal?}) 返回 Promise<{latitude,longitude,accuracy,timestamp,coordinateSystem:'WGS-84'}>。数值有限/范围有效；timestamp为Unix毫秒。仅单次，无watch、无缓存坐标、无位置持久化/日志/上传。
- SDK提供稳定错误 code：PERMISSION_DENIED、UNAVAILABLE、TIMEOUT、ABORTED、UNSUPPORTED、CONFIGURATION、INVALID_RESULT、BUSY、DISPOSED；细分只用固定diagnostic枚举，不反射原始错误/URL/签名。
- 微信手机H5/WebView优先官方JS-SDK getLocation(type:wgs84)，PC及普通WAP使用浏览器 Geolocation；按能力检测、不拿IP接口伪造设备定位。微信权限拒绝不换通道再次索权。无终端（Node/Bun/Deno）调用明确UNSUPPORTED，普通导入/Fetch保持可用。
- 原始文档URL在平台构造工厂时捕获，签名只去hash、保留query编码/顺序。公开配置必须匹配该URL、合法wx AppID、正整数timestamp、nonce和40hex签名；配置不可由应用传AppID替换。
- 同源SDK资源和签名URL由平台固定；MGR现有配置保持服务端单一AppID来源，复用现有同源签名BFF，不改变线上配置或管理协议。
- 配置共享一次有界10秒操作，单个等待者取消不破坏其他等待者；每调用总期限1..120000ms，默认20秒，最多32个并发等待者。取消/超时/销毁后回调不得返回位置；dispose取消所有等待者。平台以稳定facade在pagehide销毁实例，在pageshow.persisted创建新实例，支持缓存恢复而不替换应用持有的接口。
- 官方SDK通过私有工厂建立实例，保持原始wx/jWeixin与导航能力；拥有并清理官方SDK的Document监听器。验签失败后重建私有实例，防止ready旧状态；脚本重试使用独立查询参数。首次无定位请求时不下载官方脚本、不请求签名。
- 微信边界严格接受数值/十进制数字字符串；空值、布尔、对象、非有限、越界继续拒绝。浏览器原始timestamp继续校验，微信timestamp记录本次接收时间，不宣称设备原始采样时间。

## 联动与兼容
SDK新增可独立嵌入的location.js及官方脚本静态资源；SDK生成定位区块嵌入现有Bootstrap，不增加普通应用网络请求；Web/CLI定位区块及SDK资源逐字节一致，保留各自Bootstrap既有认证差异。现有API不改；普通应用不增加定位网络请求。CLI本地普通浏览器可定位；未配置可信线上签名的微信本地预览明确CONFIGURATION，不转发任意签名URL。当前定位应用移除所有微信/UA/签名实现，仅保留UI与SDK调用。
数据面协议、数据库、持久化、Contracts无改动；位置类型属于SDK。回滚先把当前示例迁回既有实现，再移除平台location注入；新增API旧应用无依赖。

## 验收
SDK类型、Node/Bun/Deno导入与浏览器夹具；数值格式、拒绝/不支持、总超时、取消隔离、配置共享、官方SDK真实ready重试；Web/CLI资源路由与身份保护、bootstrap同步；示例只依赖tiana.location并保留刷新清空。线上微信真机仍需配套平台版本发布后验收。
