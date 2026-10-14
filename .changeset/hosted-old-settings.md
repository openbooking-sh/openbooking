---
'@openbooking-sh/hosted': patch
---

Fix a crash for businesses saved before online payments existed: their settings have no `payments` block, which broke their booking page after the 0.11 update.
