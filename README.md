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

## Deploy free to PythonAnywhere

PythonAnywhere's Beginner plan includes one web app, a `your-username.pythonanywhere.com` address, and 512 MB of storage. AquaSupply can keep its existing SQLite database in your account's home directory, so no database migration is needed. The free plan is limited to 100 CPU-seconds per day and restricted outbound internet; use it for a demo or small pilot, not a critical production service. See [PythonAnywhere pricing](https://www.pythonanywhere.com/pricing/), its [Flask deployment guide](https://help.pythonanywhere.com/pages/Flask/), and [free-account network limits](https://help.pythonanywhere.com/pages/ExternalVCS/).

1. Create a free Beginner account and open a Bash console. Clone this public repository and install its requirements in a Python 3.13 virtual environment:

   ```bash
   git clone https://github.com/thejendramallu1/Aquaculture.git
   cd Aquaculture
   mkvirtualenv --python=/usr/bin/python3.13 aquasupply
   pip install -r requirements.txt
   ```

2. Generate two different secrets in the console by running `python -c "import secrets; print(secrets.token_urlsafe(48))"` twice. Keep both values private.
3. In the **Web** tab, add a **Manual configuration** web app using Python 3.13. Set its virtualenv to `aquasupply` and edit the WSGI configuration file. Set the following values **before** importing the app, replacing each placeholder with your own value and username:

   ```python
   import os
   import sys

   project_dir = "/home/your-username/Aquaculture"
   os.environ["AQUASUPPLY_SECRET_KEY"] = "paste-your-first-generated-secret"
   os.environ["AQUASUPPLY_SETUP_TOKEN"] = "paste-your-second-generated-secret"
   os.environ["AQUASUPPLY_COOKIE_SECURE"] = "true"
   os.environ["AQUASUPPLY_DB"] = "/home/your-username/aquasupply-data/aquasupply.sqlite3"
   sys.path.insert(0, project_dir)

   from app import app as application
   ```

   Keep this WSGI file private; do not commit your secrets to GitHub. The app creates the database directory on startup.
4. Save the WSGI file and click **Reload** in the Web tab. Visit `https://your-username.pythonanywhere.com`, choose **Set up admin**, and enter your second generated secret as the one-time setup token.

The database path above is outside the Git checkout, so code updates won't replace it. Back it up periodically. To update the app later, pull changes in the Bash console and reload the web app.

## Deploy to Render (paid option)

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
