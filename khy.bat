@echo off
:: Khy-OS 启动器 - 无需配置即可使用
:: 将此文件复制到任意位置都能使用

cd /d C:\khy-os
node services\backend\bin\khy.js %*
