@echo off
REM ============================================================
REM  toutiao-run.cmd - Toutiao automation wrapper for Trae/agents
REM  Usage:
REM    toutiao-run.cmd env-check
REM    toutiao-run.cmd scheduler status
REM    toutiao-run.cmd publish-toutiao --title "TITLE" --content "FILE.md" [--image "IMG"]
REM    toutiao-run.cmd publish-article --title "TITLE" --content "FILE.md"
REM    toutiao-run.cmd analyze | report | windows | fetch-stats
REM ============================================================
setlocal
set "BASE=%~dp0"
REM 按你的环境修改下面三行（node/python 建议加入系统 PATH）
set "NODE=node"
set "PY=python"
set "NODE_PATH=%BASE%node_modules"

if "%~1"=="" goto usage
set "CMD=%~1"
shift

if /i "%CMD%"=="env-check" goto run_envcheck
if /i "%CMD%"=="publish-toutiao" goto run_pub_t
if /i "%CMD%"=="publish-article" goto run_pub_a
if /i "%CMD%"=="scheduler" goto run_sched
if /i "%CMD%"=="analyze" goto run_analyze
if /i "%CMD%"=="report" goto run_report
if /i "%CMD%"=="windows" goto run_windows
if /i "%CMD%"=="fetch-stats" goto run_stats
if /i "%CMD%"=="queue-publish" goto run_queue
goto usage

:run_envcheck
"%NODE%" "%BASE%test-env.js"
exit /b %errorlevel%

:run_pub_t
"%NODE%" "%BASE%publish-toutiao.js" %1 %2 %3 %4 %5 %6 %7 %8 %9
exit /b %errorlevel%

:run_pub_a
"%NODE%" "%BASE%publish-article.js" %1 %2 %3 %4 %5 %6 %7 %8 %9
exit /b %errorlevel%

:run_sched
"%NODE%" "%BASE%scheduler.js" %1 %2 %3 %4 %5 %6 %7 %8 %9
exit /b %errorlevel%

:run_analyze
"%PY%" "%BASE%toutiao_scheduler.py" analyze
exit /b %errorlevel%

:run_report
"%PY%" "%BASE%toutiao_scheduler.py" report
exit /b %errorlevel%

:run_windows
"%PY%" "%BASE%toutiao_scheduler.py" windows
exit /b %errorlevel%

:run_stats
"%NODE%" "%BASE%fetch-stats.js"
exit /b %errorlevel%

:run_queue
"%NODE%" "%BASE%queue-publish.js"
exit /b %errorlevel%

:usage
echo Usage:
echo   toutiao-run.cmd env-check
echo   toutiao-run.cmd scheduler status
echo   toutiao-run.cmd publish-toutiao --title "T" --content "FILE.md" [--image "IMG"]
echo   toutiao-run.cmd publish-article --title "T" --content "FILE.md"
echo   toutiao-run.cmd analyze ^| report ^| windows ^| fetch-stats
exit /b 1
