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

## Deploy to Render

The included `render.yaml` configures a single-instance Python web service in Singapore, a 1 GB persistent disk for the SQLite database, HTTPS-only session cookies, generated secret keys, and a database health check. Render's smallest paid web service and persistent disk are paid resources; the estimated base price is approximately US$7.25/month, before taxes or additional usage. Check the [current compute pricing](https://render.com/pricing#compute) and [disk pricing](https://render.com/docs/disks).

To deploy, push the project to GitHub, sign in to [Render](https://dashboard.render.com), choose **New → Blueprint**, connect `thejendramallu1/Aquaculture`, select the `main` branch, review the service and disk costs, and confirm deployment. Render generates `AQUASUPPLY_SECRET_KEY` and `AQUASUPPLY_SETUP_TOKEN` during Blueprint setup. Keep both values private. Copy the generated setup token from the service's **Environment** settings, open the deployed `onrender.com` address, select **Set up admin**, and enter that token to claim the first administrator account. Once an administrator is created, first-time setup is permanently disabled.

The persistent disk keeps the SQLite database across deploys. This single-instance SQLite setup is intended for a small deployment and cannot be horizontally scaled. For multi-instance or higher-availability deployments, migrate the application database to a managed PostgreSQL service before scaling.

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

The local Flask server is for development. Render uses Waitress, HTTPS, a persistent secret key, and `AQUASUPPLY_COOKIE_SECURE=true`. Do not expose the development server directly to the internet.

The recommendation score is a transparent hand-weighted baseline, not a trained or validated Linear Discriminant Analysis model or nutritional advice. Validate feed suitability and local requirements with a qualified aquaculture professional.
