# Trigon Estimation — تريجون للتسعير

## العربية

تطبيق لتسعير المناقصات الإنشائية. يقرأ تكاليف الشركة (الرواتب، المصاريف العامة، المعدات، أسعار أوامر الشراء) من قاعدة بيانات نظام Trigon ERP **للقراءة فقط**، ويحسب سعر المناقصة (التكلفة الحقيقية، الحد الأدنى للسعر، السعر المقترح). الواجهة بالعربية والإنجليزية.

### التثبيت والتشغيل
1. على جهاز ويندوز الذي عليه نظام الـ ERP، انسخ مجلد التطبيق (أو `git clone`).
2. انقر مرتين على `Estimation-Start.bat`. إذا لم يكن Node.js مثبتاً (الإصدار 22.5 أو أحدث) سيثبّته البرنامج عبر `winget` مرة واحدة؛ ثم أغلق النافذة وشغّل الملف مرة ثانية.
3. يفتح المتصفح على `http://localhost:3100`. اترك نافذة الأوامر مفتوحة أثناء العمل؛ إغلاقها يوقف التطبيق. يعيد التطبيق تشغيل نفسه تلقائياً إذا توقف.
4. لتشغيل التطبيق مع بدء ويندوز: شغّل `Estimation-Autostart.bat` مرة واحدة (ينشئ اختصاراً على سطح المكتب وفي مجلد Startup).
5. تعرض النافذة عناوين IPv4 للجهاز. يفتح مهندس الكميات (QS) من جهازه `http://<العنوان>:3100`.

### إعداد المدير الأول
عند أول فتح للتطبيق تظهر شاشة إنشاء حساب المدير: اختر اسم مستخدم وكلمة مرور قوية. بعدها ينشئ المدير من شاشة الإعدادات حسابات المستخدمين: `qs` (يسعّر ويقدّم المناقصات)، `viewer` (عرض فقط). الاعتماد النهائي للمناقصة للمدير فقط. من نفس الشاشة يغيّر المدير دور المستخدم أو يعطّله أو يعيد تعيين كلمة مروره؛ أي تغيير يُخرج ذلك المستخدم من التطبيق، ولا يمكن خفض دور آخر مدير فعّال أو تعطيله.

### مسار الـ ERP
من **الإعدادات ← مسار قاعدة بيانات الـ ERP** اكتب المسار الكامل لملف `data\erp.db` الخاص بنظام الـ ERP على نفس الجهاز، مثلاً `C:\Trigon-ERP\data\erp.db`. ثم اضغط «زامن الآن» في شاشة تكاليف الشركة. تتم المزامنة تلقائياً كل ساعة. إذا فشلت المزامنة (الملف غير موجود أو مقفل) يبقى آخر سجل ناجح قيد الاستعمال ويظهر شريط أحمر بوقت آخر مزامنة ناجحة.

### ربط التصنيفات والمسميات الوظيفية
بعد أول مزامنة تعرض شاشة تكاليف الشركة تحذيرات: تصنيفات فواتير غير مربوطة (هل هي مصاريف عامة أم لا) ومسميات وظيفية غير مربوطة (إلى أي مهنة وأي مجموعة تنتمي). اربطها من **الإعدادات** ثم زامن مرة أخرى. أي مسمى غير مربوط لا يدخل في أسعار المهن.

### السماح بالمنفذ 3100 في جدار حماية ويندوز (الشبكات الخاصة فقط)
شغّل موجه الأوامر **كمسؤول** ونفّذ:

```
netsh advfirewall firewall add rule name="Trigon Estimation 3100" dir=in action=allow protocol=TCP localport=3100 profile=private
```

لا تفتح المنفذ على الشبكات العامة. للحذف: `netsh advfirewall firewall delete rule name="Trigon Estimation 3100"`.

### التطبيق لا يكتب أبداً في الـ ERP
يفتح التطبيق قاعدة بيانات الـ ERP بوضع القراءة فقط، ويأخذ منها مجاميع فقط (متوسط أجر كل مهنة وعدد العاملين) دون أسماء أو أرقام هوية أو رواتب فردية. المهن التي يقل عدد عامليها عن 3 لا تظهر أجورها لمهندس الكميات.

### النسخ الاحتياطي
كل بيانات التطبيق في مجلد `data`: الملف `data\estimation.db` (وستُضاف لاحقاً `data\drawings`). يأخذ `Estimation-Start.bat` نسخة يومية تلقائياً إلى `data\backups\estimation-YYYYMMDD.db` ويحتفظ بآخر 14 نسخة. انسخ مجلد `data` بانتظام إلى قرص أو جهاز آخر.

### التحديث
أوقف التطبيق (أغلق نافذة الأوامر)، ثم نفّذ `git pull` أو استبدل ملفات التطبيق بالنسخة الجديدة **دون حذف مجلد `data`**، ثم شغّل `Estimation-Start.bat`. تُحدَّث قاعدة البيانات تلقائياً.

---

## English

A construction tender estimating app. It reads company costs (payroll, overhead, equipment, purchase-order prices) from the Trigon ERP database **read-only** and computes the tender price (true cost, floor price, proposed price). The UI is Arabic and English.

### Install and start
1. On the Windows PC that runs the ERP, copy the app folder (or `git clone`).
2. Double-click `Estimation-Start.bat`. If Node.js (version 22.5 or newer) is missing it is installed once through `winget`; then close the window and double-click the file again.
3. The browser opens `http://localhost:3100`. Keep the command window open while you work; closing it stops the app. The app restarts itself if it stops.
4. To start the app when Windows starts, run `Estimation-Autostart.bat` once (it creates a Desktop shortcut and a Startup-folder shortcut).
5. The window prints this PC's IPv4 addresses. The QS opens `http://<that-address>:3100` from their own PC.

### First admin setup
The first time the app opens it asks you to create the admin account: choose a username and a strong password. The admin then creates users in Settings: `qs` (prices and submits tenders) and `viewer` (read only). Only the admin gives the final approval of a tender. On the same screen the admin changes a user's role, disables a user or resets a password; any change signs that user out, and the last active admin cannot be demoted or disabled.

### Set the ERP path
Go to **Settings → ERP database path** and enter the full path of the ERP's `data\erp.db` on the same PC, for example `C:\Trigon-ERP\data\erp.db`. Then press **Sync now** on the Company costs screen. The app also syncs every hour. If a sync fails (file missing or locked) the last good snapshot stays in use and a red banner shows the time of the last good sync.

### Map bill categories and designations
After the first sync, the Company costs screen lists warnings: unmapped bill categories (overhead or not) and unmapped designations (which trade and which group). Map them in **Settings**, then sync again. An unmapped designation is left out of the trade rates.

### Allow port 3100 in Windows Firewall (Private networks only)
Open a Command Prompt **as Administrator** and run:

```
netsh advfirewall firewall add rule name="Trigon Estimation 3100" dir=in action=allow protocol=TCP localport=3100 profile=private
```

Do not open the port on Public networks. To remove the rule: `netsh advfirewall firewall delete rule name="Trigon Estimation 3100"`.

### The app never writes to the ERP
The ERP database is opened read-only and only aggregates are taken from it (average rate and headcount per trade), never names, ID numbers or individual salaries. A trade with fewer than 3 people never shows its own rate to the QS.

### Backups
All app data lives in the `data` folder: `data\estimation.db` (and `data\drawings` later). `Estimation-Start.bat` takes a daily copy to `data\backups\estimation-YYYYMMDD.db` and keeps the last 14. Copy the `data` folder regularly to another disk or PC.

### Updating
Stop the app (close the command window), run `git pull` or replace the app files with the new version **without deleting the `data` folder**, then start `Estimation-Start.bat`. The database upgrades itself.

## Development
`npm test` runs every `test-*.js` suite. No dependencies; Node 22.5 or newer.
