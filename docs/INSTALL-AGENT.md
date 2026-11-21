# Install Trigon Estimation on the office PC — instructions for the local agent

> **للوكيل (Agent):** هذا الملف تعليمات كاملة لتركيب برنامج Trigon Estimation على جهاز المكتب. نفّذ الخطوات بالترتيب، وتوقّف واسأل صاحب الشركة عند أي خطوة مكتوب عندها **اسأل**.
>
> **For the agent:** follow the steps in order. Stop and ask the owner wherever a step says **ASK**. Report back in Arabic (Levantine/Gulf), in plain words.

## 0. What this is

- **Trigon Estimation:** a tender-pricing and quantity take-off web app for a UAE construction company.
  - Node.js, zero npm dependencies, built-in `node:sqlite`.
  - It runs on one Windows PC. Others in the office open it in a browser on port 3100.
- **Repository:** `https://github.com/MohanadAyyash/Trigon-Estimation` (branch `main`).
- **The ERP:** the same PC runs the company's **Trigon ERP**, which holds financial production data.
  - Estimation reads the ERP database **read-only**.
  - You install the app next to the ERP. **You do not touch the ERP.**

## 1. Hard rules (read before doing anything)

1. **Never open, copy, move, modify, back up, upload or print the ERP database** (`erp.db` or anything in the ERP's `data` folder). Never run SQL against it. Never paste its contents anywhere.
   - The only thing that happens with it: the owner types its path into the app's Settings screen (step 7).
   - You may check that the file *exists* (`Test-Path`), nothing more.
2. **Never stop, restart, update or reconfigure the ERP** or its scheduled tasks, services or ports. If the ERP uses port 3100, **ASK** before changing anything (see step 5).
3. **No personal data leaves this PC.** Do not send salaries, names, IDs, IBANs or company figures to any website, issue, chat or log you share.
4. **Do not change the app's code** to make something work. If a step fails, stop and report the exact error.
5. **Do not push anything to GitHub.** You only clone and pull.
6. **Do not create user accounts or passwords for the owner.** The owner creates the admin account himself (step 6).
7. **Ask before running anything as Administrator.** Only one command needs it: the firewall rule in step 8.

## 2. Check the PC

Run in PowerShell (a normal user, not admin):

```powershell
[Environment]::OSVersion.VersionString
node -v
git --version
winget --version
Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue
```

**Node.js:**
- Needs **22.5 or newer, in the 22.x line** (Node 22 LTS). Node 23 or newer is untested: **ASK** before using it.
- If Node is missing or older than 22.5, install Node 22 LTS:

  ```powershell
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  ```

- If winget installs a version other than 22.x, uninstall it and install 22.x from https://nodejs.org (the "22.x LTS" Windows installer).
- Open a **new** PowerShell window afterwards and check `node -v` again.

**Git:**
- If Git is missing, install it:

  ```powershell
  winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
  ```

**Port 3100:**
- If something is already listening on port 3100, write down which process it is and go to step 5.

## 3. Choose the folder

- **ASK** the owner where to install. Suggest `C:\Trigon-Estimation`.
- It must be on a local disk, **not** inside the ERP's folder, **not** in OneDrive or another synced folder, and not on a network drive. SQLite files must not live in synced folders.
- Make sure the folder does not exist yet, or is empty.

## 4. Get the code

```powershell
cd C:\
git clone https://github.com/MohanadAyyash/Trigon-Estimation.git
cd C:\Trigon-Estimation
git checkout main
git log --oneline -1
```

**If the clone asks for a login:** the repository may be private.
- Let the owner sign in to GitHub in the window that opens (Git Credential Manager).
- **Do not** ask for, type or store his password or token yourself.

## 5. Test that it works on this PC (before starting it for real)

Run the automated tests. They start the app on temporary folders and never touch real data or the ERP.

```powershell
cd C:\Trigon-Estimation
npm test
```

- **Expected:** the last line says `all 17 test file(s) passed` (the number can be higher in newer versions).
- It takes a few minutes.
- The browser tests are skipped automatically, with the message `playwright not installed, browser smoke skipped`. That is fine: **do not install Playwright** or any npm package.
- If anything fails, **stop** and report the failing file name and the error lines.

**Port conflict:**
- If port 3100 was taken in step 2, **ASK** the owner.
- If he agrees to another port (for example 3200), change only this line in `Estimation-Start.bat`: `set PORT=3100`. The firewall rule in step 8 must then use the same port.
- Never stop the program that holds the port.

## 6. First start and the admin account

1. Double-click `Estimation-Start.bat`, or run it from the folder.
   - It takes a backup (`data\backups`) and starts the server.
   - It opens `http://localhost:3100`.
   - It prints this PC's IPv4 addresses.
2. The app shows **create the admin account**. **Hand the keyboard to the owner.** He chooses the username and a strong password. Do not see, suggest or record the password.
3. The command window must stay open. Closing it stops the app, and the app restarts itself if it crashes.

## 7. Connect to the ERP (the owner does this)

**ASK** the owner for the full path of the ERP database file. It is usually inside the ERP's folder, for example `C:\Trigon-ERP\data\erp.db`.

You may confirm it exists, read-only:

```powershell
Test-Path "C:\Trigon-ERP\data\erp.db"
```

Then the owner, logged in as admin:

1. In the app, goes to **Settings → ERP database path** (الإعدادات ← مسار قاعدة بيانات الـ ERP), pastes the path and saves.
2. Goes to **Company costs** (تكاليف الشركة) and presses **Sync now** (زامن الآن).
3. Maps the unmapped bill categories and job titles that the screen lists. These are his business decisions; do not choose them for him. Then he syncs again.

How the sync behaves:
- It runs every hour by itself.
- It only reads totals: no names or individual salaries.
- If it shows a red banner (file not found or locked), report the message and do not try to "fix" the ERP.

## 8. Office network access (optional; needs Administrator)

Do this only if the QS should open the app from another PC.

1. **ASK** first. Then, in a Command Prompt opened **as Administrator**:

   ```bat
   netsh advfirewall firewall add rule name="Trigon Estimation 3100" dir=in action=allow protocol=TCP localport=3100 profile=private
   ```

2. The office network must be set to **Private** in Windows: Settings → Network & Internet → the network → Private. **Never** open the port on Public networks.
3. From another office PC, open `http://<IPv4 shown in the window>:3100`.

## 9. Start with Windows (optional)

- Double-click `Estimation-Autostart.bat` once.
- It puts a "Trigon Estimation" shortcut on the Desktop and in the user's Startup folder, so the app starts when this user signs in.
- No admin rights are needed.

## 10. Backups — explain to the owner

- **What gets backed up:**
  - Each start copies `data\estimation.db` to `data\backups\estimation-YYYYMMDD.db` (one per day, the last 14 kept).
  - Drawings are mirrored to `data\backups\drawings`.
- **If a backup fails:** the start window shows a warning, and the reason is written to `data\backups\backup-errors.log`.
- **Recommend to the owner:**
  - Copy the whole `C:\Trigon-Estimation\data` folder to another disk or PC regularly.
  - The database and the `drawings` folder belong together.
- **Restore steps** are in `README.md` (section "Backup"). Do not restore anything unless the owner asks.

## 11. Updating later

When the owner asks for an update:

```powershell
cd C:\Trigon-Estimation
git pull origin main
npm test
```

Then:
- Close the app's window and start `Estimation-Start.bat` again.
- The `data` folder is never touched by `git pull`: it is not in the repository.

## 12. Report back to the owner (in Arabic)

When done, tell the owner in short plain Arabic:

- **Versions:** the Node version, and the commit you installed (`git log --oneline -1`).
- **Folder:** where the app is installed, and the address to open (`http://localhost:3100` and the office IPv4).
- **Tests:** whether all tests passed, and anything skipped.
- **Optional steps:** whether the firewall rule and autostart were added.
- **Owner's own steps:**
  1. Create the admin account (if not done yet).
  2. Set the ERP path.
  3. Press Sync now.
  4. Map the categories and job titles.
  5. Create a `qs` user for the quantity surveyor.
- **Problems:** anything that failed, with the exact message.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `node` not found after installing | Open a new terminal window, or sign out and back in. |
| `node:sqlite` error or "experimental" message | Node is older than 22.5. Install Node 22 LTS. |
| Browser cannot reach `localhost:3100` | Is the command window still open? Is another program on 3100? (step 2) |
| QS cannot reach the app from his PC | Firewall rule missing, network set to Public, or wrong IPv4 (step 8). |
| Red ERP banner | Wrong path, or the ERP file is locked by a backup tool. Report it. **Do not touch the ERP file.** |
| "drawing too large to parse" | Expected for huge DXF files. The owner purges or splits the drawing in AutoCAD. |
| A test fails | Stop and report the file name and the error. Do not edit code. |
