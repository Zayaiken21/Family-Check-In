# Privacy and Safety Notes

Family Check-In is intentionally designed around explicit parent actions rather than continuous location surveillance.

## Location collection
- Location is requested only after the parent presses **Confirm location**.
- The browser displays its own location-permission prompt.
- A check-in may include latitude, longitude, device-reported accuracy, altitude, speed, heading, client timestamp and server timestamp.
- The app does not silently track the device in the background.

## Access
- A parent can read their own records.
- A caseworker can read records only after an active parent-caseworker relationship is created using an invite code.
- A parent can revoke that relationship from the app.
- Row Level Security policies enforce these rules in the database, not just in the user interface.

## Sensitive information
Precise location and family-court information are highly sensitive. Do not use a public spreadsheet or put exported CSV files in a public GitHub repository. Treat exports as confidential case records.

## Accuracy
GPS accuracy varies by device, building, network and environment. The app stores the device-reported accuracy radius so reviewers can see uncertainty rather than treating coordinates as exact.
