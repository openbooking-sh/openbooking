---
'@openbooking-sh/notifications': patch
'@openbooking-sh/google-calendar': patch
---

Provider errors no longer carry customer details into logs. A failed Resend send reports only the HTTP status and Resend's error name, and a failed Google Calendar call only the status and Google's error code, both with any email address removed. Their messages could quote the recipient address or the event (customer name, email and phone).
