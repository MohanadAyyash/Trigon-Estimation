// The draft label of a tender's reports: a tender not yet frozen (approved, sent, won or lost) is a draft, and every report
// of it says so in both languages. One file, two users: the exports and the Excel take-off report (modules/tenders.js,
// require) and the drawing PNG export in the browser (window.TenderDraft, served at /lib/draft.js by server.js).
// Pure: no DOM, no Node APIs, no I/O.
'use strict';
(function () {
const FROZEN_STATUSES = ['approved', 'sent', 'won', 'lost'];
const DRAFT_EN = 'DRAFT — NOT APPROVED', DRAFT_AR = 'مسودة — غير معتمدة';
const isDraft = status => !FROZEN_STATUSES.includes(status);

const TenderDraft = { FROZEN_STATUSES, DRAFT_EN, DRAFT_AR, isDraft };
if (typeof module !== 'undefined' && module.exports) module.exports = TenderDraft; else window.TenderDraft = TenderDraft;
})();
