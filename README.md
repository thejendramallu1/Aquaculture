# AquaSupply

A server-backed aquaculture feed-matching app with separate sign-in workspaces for farmers, feed vendors, management, the analysis team, and administrators.

## Run locally

From this folder in PowerShell:

```powershell
python -m pip install -r requirements.txt
$env:AQUASUPPLY_SECRET_KEY = (python -c "import secrets; print(secrets.token_hex(32))")
python app.py
```

Open `http://127.0.0.1:5000` and select **Set up admin** to create the first administrator. Setup is allowed only once, while no administrator account exists. Use a password with at least 12 characters. Alternatively, create the first administrator from the terminal with `python app.py create-admin`.

## Account setup and workflow

1. Sign in as the administrator and create Management and Analysis team accounts from **Team accounts**.
2. Farmers and feed vendors register from their own sign-in pages. Their accounts remain pending until Management approves them.
3. Farmers submit farm requirements; vendors submit feed stock. Management reviews both before they can be used.
4. The Analysis team prepares a match from approved requests and stock. An administrator reviews and publishes it to the farmer.

Passwords are hashed on the server. Sessions use HTTP-only, same-site cookies; state is stored in SQLite at `instance/aquasupply.sqlite3`. Set `AQUASUPPLY_SECRET_KEY` to a long random value before starting the server so sessions survive restarts. The app binds to localhost by default.

## Tests

```powershell
python -m unittest discover -s tests
```

The local Flask server is for development. For deployment, use a production WSGI server, HTTPS, a persistent secret key, and set `AQUASUPPLY_COOKIE_SECURE=true`. Do not expose the development server directly to the internet.

The recommendation score is a transparent hand-weighted baseline, not a trained or validated Linear Discriminant Analysis model or nutritional advice. Validate feed suitability and local requirements with a qualified aquaculture professional.
