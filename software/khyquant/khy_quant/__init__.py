"""
KHY-Quant — AI-powered quantitative trading terminal.

KHY OS 生态的旗舰量化交易应用。
可独立安装运行，也可作为 khy-os 的插件模块。

Install:
    pip install khy-quant           # 独立安装
    pip install khy-os[quant]       # 作为 khy-os 插件
    pip install khy-quant[data]     # + 数据分析（pandas、akshare）
    pip install khy-quant[ml]       # + 机器学习（sklearn、xgboost）
    pip install khy-quant[full]     # 全部可选依赖

Quick start:
    $ khyquant                      # 启动交互式 REPL
    $ khyquant server               # 启动 Web 服务
    $ khyquant data list            # 浏览数据源
"""
__version__ = "0.1.78"
