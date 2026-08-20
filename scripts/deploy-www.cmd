@echo off
title Codesk www deploy
cd /d "%~dp0..\apps\www"
echo [Codesk] deploy official site to Cloudflare Worker
npx wrangler whoami
if errorlevel 1 (
  echo [Codesk] not logged in, opening Cloudflare login...
  npx wrangler login
)
npx wrangler deploy
if errorlevel 1 (
  echo [Codesk] custom domain failed, deploying workers.dev only...
  npx wrangler deploy --name codesk-www --assets ./public --compatibility-date 2026-08-19
)
pause
