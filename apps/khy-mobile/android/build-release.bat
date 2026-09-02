@echo off
setlocal
set "ANDROID_HOME=C:\Users\25789\.khyos\android_sdk"
set "ANDROID_SDK_ROOT=C:\Users\25789\.khyos\android_sdk"
set "JAVA_HOME=D:\Portable\Tools\jdk-21.0.12.1+1"
set "PATH=%JAVA_HOME%\bin;%ANDROID_HOME%\platform-tools;%PATH%
cd /d D:\Portable\khy-os\apps\khy-mobile\android
call gradlew.bat assembleRelease -Dorg.gradle.jvmargs="-Xmx3g"
exit /b %errorlevel%
