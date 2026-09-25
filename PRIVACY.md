# Privacy and data design

## Stored in Supabase
- case metadata
- assigned participant names and bcrypt PIN hashes
- visit start/end/review timestamps
- parent check-in timestamps
- submitted GPS coordinates and reported accuracy
- check-in method and optional notes
- caseworker compliance determination and note
- supervisor report delivery status

## Not persistently stored on Render
Render holds only transient process memory needed to serve requests, validate a request, create a report, and relay WebRTC signaling. The application code does not write family records to Render's filesystem or a Render database.

## Not stored by the app
- browser video/audio call media
- camera test footage
- continuous/background GPS trails

## Consent design
Geolocation is requested only after a parent presses **Confirm location**. Camera/microphone activate only after the user requests a device test, initiates a call, accepts a call, or chooses a video check-in.

## Retention
The schema does not automatically delete court/visit records. Organizations should adopt a written retention policy and configure Supabase backups/access controls accordingly.
