---
'@openbooking-sh/hosted': minor
'@openbooking-sh/booking-page': minor
'@openbooking-sh/server': minor
---

Age rules on hosted. Sign-up says you must be 18 or older to create an account, and every hosted booking page shows a notice above the confirm button for bookings made on behalf of a child (a parent or guardian books, with the child's name in the notes). For your own deployment the notice is an option and off by default: `childNotice` on the booking page (and `bookingPage.childNotice` in the server).
