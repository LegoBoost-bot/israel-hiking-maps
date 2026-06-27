# OpenCode Agent Instructions — Israel Hiking Maps (Mapeak)

This repository holds the ASP.NET Core backend and the Angular SPA (wrapped via Capacitor for iOS/Android) for Mapeak (Israel Hiking Maps).

---

## 1. Directory Layout & Boundaries
* **`IsraelHiking.Web/`**: The host application. Holds the main entry point for the backend server (`Program.cs`) and contains all frontend files under `IsraelHiking.Web/src/`.
* **`IsraelHiking.API/`**: Controllers, executors, converters, and core server business logic.
* **`IsraelHiking.DataAccess/`**: Integration gateways (ElasticSearch, GraphHopper, Overpass Turbo, Wikidata, iNature, etc.).
* **`IsraelHiking.Common/`**: Shared POCO models and configuration models.
* **`Tests/`**: Mock-heavy tests. Only `Tests/IsraelHiking.API.Tests` is executed by standard CI.

---

## 2. Frontend Constraints & Workflow
All frontend actions should be executed from the `IsraelHiking.Web/` subdirectory.

* **ESLint Quote Enforcements**: You **must** use **double quotes (`"`)** rather than single quotes (`'`) in all TypeScript (`.ts`) files.
* **Required Codegen**: Run this to generate type definitions from OpenAPI before any production build or mobile sync:
  ```bash
  npm run generate-user-data-types
  ```
* **Build Target**: Angular outputs to `IsraelHiking.Web/wwwroot/`. The ASP.NET Core backend serves it.
* **Essential Commands**:
  * Install dependencies: `npm ci`
  * Dev watch: `npm run build:watch`
  * Production build: `npm run build:prod`
  * Linting: `npm run lint` (uses `ng lint --fix`)
  * Tests: `npm run test` or `npm run test-ci`

---

## 3. Backend Constraints & Workflow
* **MyGet Nuget Source**: Nuget depends on a specific NetTopologySuite feed. Ensure `nuget.config` at the repository root is intact:
  ```xml
  <add key="nettopologysuite" value="https://www.myget.org/F/nettopologysuite/api/v3/index.json" />
  ```
* **C# / .NET Conventions**: Uses **.NET 9.0** and **C# 12** features (including collection expressions `[]` and file-scoped namespaces).
* **Secrets Configuration**:
  * Public settings map to `ConfigurationData` from `appsettings.json`.
  * External keys (Wikimedia, Fovea, RevenueCat) are defined in `NonPublicConfigurationData`. In **Development**, configure these using `.NET user-secrets`. In **Production**, they are read from `nonPublic.json`.
* **Database & Cache**:
  * Automatically creates a SQLite cache database at `./Cache/cache.sqlite` inside the server's working directory.
* **Running & Testing (from root)**:
  * Local Run: `dotnet run --project IsraelHiking.Web`
  * Run API Tests: `dotnet test Tests/IsraelHiking.API.Tests`

---

## 4. Local Integration Microservices
To run the full navigation, routing, elevation, or search stack locally, spin up the Docker services via `docker-compose.yml`:
* `elasticsearch` (v7.17.8) - port `9200` (search database)
* `graphhopper` (v10.2) - port `8989` (routing engine)
* `gpsbabel` - port `11987` (GPS tracks conversion)
* `translation` - port `5432` (translation service)
* `user-data` - port `3000` (user state server)
* `tileserver-gl` - port `11223` (renders map vector styles)

---

## 5. Mobile & Release Sync
* **Capacitor Sync**:
  ```bash
  npm run build:mobile && npx cap sync android
  npm run build:mobile && npx cap sync ios
  ```
* **Release Checklist**:
  * Add release notes to `IsraelHiking.Web/ios/App/fastlane/metadata/en-US/release_notes.txt` and `IsraelHiking.Web/android/fastlane/metadata/android/en-US/changelogs/default.txt`.
  * Push to `main` and trigger the `Build and Publish` workflow manually on GitHub.
