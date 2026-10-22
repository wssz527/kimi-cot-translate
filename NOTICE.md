# 项目及第三方说明

`kimi-cot-translate` 是独立实现的非官方实验性扩展，与 Kimi Code、Moonshot AI、Microsoft、Google 无隶属或背书关系。

分享包仅包含扩展源码、说明、测试与扩展构建产物，不包含 Kimi Code、Electron 或任何第三方应用的二进制文件。常规测试使用合成内容；显式设置 `KCT_KIMI_BIN` 的 CLI 集成测试会在隔离目录中启动指定的官方 CLI，并使用本机模拟模型端点。

翻译请求格式参考了 DSH 的实验翻译器；本包没有捆绑 DSH 项目。源码中的 Bing、Google 和自定义服务接口由对应服务方提供，服务可用性不由本扩展控制。

此版本是本地生成的安装试用包，尚未指定开源许可证。
