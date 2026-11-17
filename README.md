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

لا تفتح المنفذ على الشبكات العامة. يجب أن يكون نوع شبكة المكتب في ويندوز «خاصة» (Private) وإلا لن يصل مهندس الكميات إلى التطبيق: من الإعدادات ← الشبكة والإنترنت ← خصائص الشبكة اختر «شبكة خاصة». للحذف: `netsh advfirewall firewall delete rule name="Trigon Estimation 3100"`.

### التطبيق لا يكتب أبداً في الـ ERP
يفتح التطبيق قاعدة بيانات الـ ERP بوضع القراءة فقط، ويأخذ منها مجاميع فقط (متوسط أجر كل مهنة وعدد العاملين) دون أسماء أو أرقام هوية أو رواتب فردية. المهن التي يقل عدد عامليها عن 3 لا تظهر أجورها لمهندس الكميات.

### المخططات والقياس (Take-off)
- **الرفع:** من تبويب «المخططات» في المناقصة ارفع ملف DXF نصي (ASCII) حتى 100 MB. الـ DXF الثنائي يُرفض: احفظه من AutoCAD كـ ASCII DXF. يُقرأ الملف في الخلفية؛ الملف نفسه المرفوع مرة ثانية يُستعمل فوراً.
- **الوحدات:** لا تظهر أي كمية قبل تأكيد وحدة المخطط (مم، سم، م، كم، قدم، إنش). الوحدة المقترحة من الملف تظهر مختارة مسبقاً؛ تأكد منها ثم اضغط «تأكيد الوحدات». لا تتغير الوحدة بعد وجود قياسات.
- **جدول الطبقات:** لكل طبقة طول الخطوط المفتوحة، ومحيط الأشكال المغلقة، والمساحة، وعدد البلوكات (المستوى الأعلى / المتداخلة)، مع تنبيهات: أشكال خارج المساحة، منحنيات تقريبية، أشكال غير مقيسة، تكرار محتمل.
- **الربط:** زر «ربط…» بجانب الرقم يربطه ببند BOQ، مع عرض أو عمق أو معامل عند الحاجة. وحدة البند يجب أن توافق وحدة القياس (م، م²، م³، عدد).
- **العارض:** «فتح العارض» يعرض المخطط: العجلة للتكبير، السحب بالزر الأوسط أو الأيمن للتحريك، وإظهار الطبقات وإخفاؤها (لا يغيّر الكميات).
- **التحديد:** نقر، أو «نافذة» (العناصر داخل المستطيل كاملة)، أو «تقاطع» (ما يلمسه المستطيل). المجموع المعروض **معاينة فقط**؛ الكمية المحفوظة يحسبها الخادم من الملف الأصلي. عدد البلوكات يكون **بالاسم وفي المستوى الأعلى**؛ البلوكات المتداخلة تظهر منفصلة ولا تُعدّ إلا باختيار «تضمين البلوكات المتداخلة». «عرض» في قائمة القياسات يُظهر عناصر قياس محفوظ.
- **التأكيدات:** يطلب التطبيق تأكيداً صريحاً (ويسجّله) قبل حفظ: كمية ناقصة، تكرار محتمل، جزء مقيس من قبل على نفس البند، عدّ أكثر من بلوك معاً، أو وحدة بند غير معروفة.
- **PDF والصور:** يمكن أيضاً رفع ملف PDF (حتى 100 MB) أو صورة PNG/JPG (حتى 50 MB). تُقرأ صفحات الـ PDF في المتصفح وتصبح كل صفحة مخططاً مستقلاً.
- **المعايرة (PDF والصور):** لا تظهر كمية طول أو مساحة قبل المعايرة. «معايرة»: انقر نقطتين واكتب الطول الحقيقي بينهما. المقياس يظهر دائماً تحت المخطط («1 نقطة = … م»). «تحقق من المقياس»: خط ثانٍ معروف الطول يعرض الفرق %، وفوق 1 % يظهر بلون التحذير. «منطقة»: اسحب مستطيلاً ثم عايِر داخله (لتفاصيل بمقياس مختلف)؛ القياس يأخذ مقياس المنطقة التي فيها أول نقطة له. إعادة المعايرة بعد وجود قياسات تعرض جدول «قبل / بعد» ولا يتغير شيء قبل «اعتمد».
- **القياس اليدوي (PDF والصور وDXF):** خط، مسار، مساحة (مع «فتحة» للخصم داخلها)، مستطيل، عدّ. «تراجع نقطة» يحذف آخر نقطة، وEnter أو النقر المزدوج للإنهاء، وEsc للإلغاء. على DXF يلتقط «الالتقاط» الرؤوس الحقيقية بدقة؛ على PDF والصور يبقي Shift الخط أفقياً أو عمودياً. القيمة أثناء الرسم **معاينة**؛ الكمية المحفوظة يحسبها الخادم. «إنهاء» يفتح نموذج الربط نفسه (البند، العرض، العمق، المعامل، الخصم). قائمة القياسات تعرض المعادلة («طول 350.00 نقطة × 0.05 م/نقطة = 17.50 م») والمعايرة المستعملة، ويمكن تعديل القياس أو حذفه. العدّ على PDF والصور لا يحتاج معايرة.
- **النسخ الاحتياطي:** ملفات المخططات في `data\drawings` وتُنسخ يومياً إلى `data\backups\drawings` (انظر «النسخ الاحتياطي» أدناه).

### النسخ الاحتياطي
كل بيانات التطبيق في مجلد `data`: الملف `data\estimation.db` والمجلد `data\drawings` (ملفات المخططات المرفوعة). انسخهما **معاً** دائماً: القياسات في قاعدة البيانات تعتمد على ملفات المخططات. عند كل تشغيل لـ `Estimation-Start.bat` تؤخذ نسخة من قاعدة البيانات إلى `data\backups\estimation-YYYYMMDD.db` إن لم تكن نسخة اليوم موجودة (أي نسخة واحدة يومياً عند التشغيل، لا نسخة كل يوم إن لم يُشغَّل التطبيق)، ويحتفظ بآخر 14 نسخة. وتُنسخ ملفات المخططات تلقائياً أيضاً إلى `data\backups\drawings` (الملفات الناقصة فقط، ولا يُحذف منها شيء). **الاستعادة:** أوقف التطبيق (أغلق نافذة الأوامر)؛ احذف الملفين `data\estimation.db-wal` و`data\estimation.db-shm` إن وُجدا (وإلا قد تُعاد عليها تغييرات قديمة من قاعدة البيانات السابقة)؛ انسخ `data\backups\estimation-YYYYMMDD.db` المطلوبة إلى `data\estimation.db` (بعد تغيير اسمها إلى `estimation.db`)؛ انسخ محتويات `data\backups\drawings\*` إلى `data\drawings`؛ ثم شغّل التطبيق. أي ملخص مفقود لمخطط يُبنى من جديد تلقائياً من ملف DXF المحفوظ دون إعادة رفعه. إذا فشل النسخ تظهر رسالة تحذير في نافذة الأوامر ويُسجَّل السبب في `data\backups\backup-errors.log`؛ راجع هذا الملف من وقت لآخر. انسخ مجلد `data` بانتظام إلى قرص أو جهاز آخر.

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

Do not open the port on Public networks. The office network must be set to **Private** in Windows, otherwise the QS cannot reach the app: Settings → Network & Internet → the network's properties → Private network. To remove the rule: `netsh advfirewall firewall delete rule name="Trigon Estimation 3100"`.

### The app never writes to the ERP
The ERP database is opened read-only and only aggregates are taken from it (average rate and headcount per trade), never names, ID numbers or individual salaries. A trade with fewer than 3 people never shows its own rate to the QS.

### Drawings & take-off
- **Upload:** in a tender's Drawings tab, upload an ASCII DXF of up to 100 MB. A binary DXF is refused: save it from AutoCAD as ASCII DXF. The file is read in the background; the same file uploaded again is ready at once.
- **Units:** no quantity is shown before the drawing's unit is confirmed (mm, cm, m, km, ft, in). The unit suggested by the file is pre-selected; check it and press Confirm units. The unit cannot change once something is measured.
- **Layer table:** per layer, the open length, the perimeter of closed shapes, the area and the block counts (top level / nested), with notes: shapes left out of the area, approximated curves, shapes not measured, possible duplicates.
- **Linking:** the Link… button next to a number links it to a BOQ row, with a width, depth or factor when needed. The row unit must match the measured unit (m, m2, m3, nr).
- **Viewer:** Open viewer shows the drawing: wheel to zoom, middle or right drag to pan, layers on and off (this never changes a quantity).
- **Selection:** click, Window (entities fully inside the box) or Crossing (anything the box touches). The total shown is a **preview only**; the saved quantity is computed by the server from the original file. Blocks are counted **by name at the top level**; nested blocks are shown apart and counted only when "Include nested inserts" is ticked. Show in the measurement list highlights a saved selection.
- **Confirmations:** the app asks for an explicit (and audited) confirmation before it saves an incomplete quantity, possible duplicates, something already measured on the same row, a count of several different blocks, or a row whose unit it does not recognise.
- **PDF and images:** a PDF (up to 100 MB) or a PNG/JPG image (up to 50 MB) can be uploaded too. The PDF's pages are read in the browser; each page becomes a drawing of its own.
- **Calibration (PDF and images):** no length or area is shown before calibrating. Calibrate: click two points and type the real length between them. The scale is always shown under the drawing ("1 pt = … m"). Verify scale: a second known line shows the difference in %, in the warning colour above 1 %. Region: drag a rectangle, then calibrate inside it (details at another scale); a measurement uses the region its first point is in. Re-calibrating once measurements exist shows a before/after table and changes nothing until Apply.
- **Measuring by hand (PDF, images and DXF):** Line, Polyline, Area (Hole subtracts a hole inside it), Rectangle, Count. Undo point removes the last point, Enter or a double-click finishes, Esc cancels. On a DXF, Snap catches the true vertices exactly; on a PDF or an image, Shift keeps the line horizontal or vertical. The value while drawing is a **preview**; the saved quantity is computed by the server. Finish opens the same link form (row, width, depth, factor, deduction). The measurement list shows the formula ("length 350.00 pt × 0.05 m/pt = 17.50 m") and the calibration used; a measurement can be edited or deleted. A count on a PDF or an image needs no calibration.
- **Backup:** the drawing files live in `data\drawings` and are copied daily to `data\backups\drawings` (see Backups below).

### Backups
All app data lives in the `data` folder: `data\estimation.db` and `data\drawings` (the uploaded drawings). Always back them up **together**: the measurements in the database depend on the drawing files. Each time `Estimation-Start.bat` starts the app it copies the database to `data\backups\estimation-YYYYMMDD.db` unless today's copy already exists (so: at most one copy per day, taken at start — no copy on a day the app is not started), and keeps the last 14. The drawing files are copied automatically too, to `data\backups\drawings` (only files not already there; nothing in that folder is ever deleted). **Restore:** stop the app (close the command window); delete `data\estimation.db-wal` and `data\estimation.db-shm` if they are there (otherwise old changes of the previous database can be replayed onto the restored one); copy the chosen `data\backups\estimation-YYYYMMDD.db` to `data\estimation.db` (renaming it to `estimation.db`); copy `data\backups\drawings\*` into `data\drawings`; then start the app. A drawing whose parsed summary is missing is rebuilt automatically from its stored DXF, with no re-upload. If a backup fails, the command window shows a warning and the reason is written to `data\backups\backup-errors.log`; check that file now and then. Copy the `data` folder regularly to another disk or PC.

### Updating
Stop the app (close the command window), run `git pull` or replace the app files with the new version **without deleting the `data` folder**, then start `Estimation-Start.bat`. The database upgrades itself.

## Development
`npm test` runs every `test-*.js` suite. No dependencies; Node 22.5 or newer.
