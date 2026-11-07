# 牵丝 Qiansi 的 DSH bundle 层。
#
# 由 `node dsh/qiansi/install.mjs` 生成：安装时把 MCP server 的绝对路径写进
# args，因为 DSH 的补丁在启动期求值，取不到 bundle 自身的 __dirname。
#
# 用法：
#   node dsh/qiansi/install.mjs            # 生成本文件（不覆盖已有 profile）
#   dsh plugin --profile <名字> add "link:<仓库>/dsh/qiansi"
#   dsh --profile <名字> --dump-config | grep qiansi
- insert:
    # 状态插件：连不上牵丝服务时在日志里说清楚该先做什么。
    - id: qiansi
      name: qiansi-dsh
      config:
        serverName: qiansi
    # 官方 MCP 桥：把牵丝的 19 个工具注册为 mcp__qiansi__*，模型可原生调用。
    - id: qiansi-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: qiansi
        transport: stdio
        command: node
        args:
          - __QIANSI_MCP_ENTRY__
        env:
          QIANSI_AGENT: dsh
        toolCallTimeoutMs: 120000
