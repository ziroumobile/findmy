# Find Mine

類似 Apple Find My 的個人裝置尋找工具。純靜態網頁（GitHub Pages）+ Supabase（登入、資料庫、Realtime）。

## 功能
- Email/密碼登入（Supabase Auth），每個人只看得到自己的裝置（RLS）
- 把手機/電腦「註冊」成裝置，每 30 秒回報位置與電量
- 地圖顯示所有裝置、精度圈、最後上線時間
- 遠端「播放聲音」（響鈴 + 震動）、「遺失模式」（全螢幕顯示聯絡訊息）、導航、24 小時軌跡、移除裝置

## 設定
1. 到 https://supabase.com 建立專案。
2. SQL Editor 貼上 `schema.sql` 執行。
3. Project Settings → API，把 URL 與 anon key 填進 `config.js`（anon key 可公開，資料由 RLS 保護，**絕對不要放 service_role key**）。
4. Authentication → URL Configuration：Site URL 填你的 GitHub Pages 網址（例如 `https://<你>.github.io/findmy/`）。想免 Email 驗證可在 Providers → Email 關閉 Confirm email。
5. 推到 GitHub repo，Settings → Pages → Deploy from branch (`main` / root)。
6. 在每個要追蹤的裝置打開網址、登入、按「＋ 註冊此裝置」並允許定位與（響鈴用的）聲音。

## 限制（網頁版的本質）
- 瀏覽器分頁必須保持開啟，且手機鎖屏/背景時定位會被系統暫停；想要真正背景追蹤需改成原生 App（例如 Capacitor 包裝 + background geolocation）。
- 響鈴需要該裝置曾與頁面互動過一次（瀏覽器自動播放限制）。
- 無法追蹤關機或離線的裝置，也沒有 Apple 的藍牙群眾網路。
