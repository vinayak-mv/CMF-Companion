# Releasing

Releases are built and published by [`.github/workflows/release.yml`](.github/workflows/release.yml)
when a `v*` tag is pushed. The workflow:

1. Checks that the tag matches the version in `Cargo.toml` and `tauri.conf.json`.
2. Builds the Windows executable and the ARM64 Android APK.
3. Creates a GitHub Release named after the tag and attaches both files, using
   [`.github/release-notes.md`](.github/release-notes.md) as the body.

`build.yml` and `android.yml` ignore `v*` tags, so a tag does not trigger a second round of
builds on top of the release.

## Cut a release

```bash
# 1. Bump the version in Cargo.toml and tauri.conf.json (package.json too, for tidiness).
git add Cargo.toml tauri.conf.json package.json
git commit -m "Release v0.1.0"
git push origin main

# 2. Tag the commit and push the tag.
git tag v0.1.0
git push origin v0.1.0
```

Watch **Actions → Release**. When both builds finish, the release appears under **Releases** with
`cmf-eq-windows-x64.exe` and `cmf-eq-android-arm64.apk` attached. The notes can be edited on
GitHub afterwards.

## If a build fails

Nothing is published until both builds succeed. Fix the problem, then move the tag:

```bash
git tag -d v0.1.0
git push origin :refs/tags/v0.1.0
git tag v0.1.0
git push origin v0.1.0
```

A red **Verify version** job means the tag and the app versions disagree — bump the versions or
retag.

## Repository settings

The workflow requests `contents: write` for the token so it can create the release. If the publish
step fails with a permissions error, check **Settings → Actions → General → Workflow permissions**
and allow read and write access.

## Signing

- The Windows executable is unsigned, so SmartScreen warns on first run. Signing would need a
  code-signing certificate and a `signtool` step in the `windows` job.
- The Android APK is debug-signed. Shipping a release-signed APK would need a keystore stored in
  repository secrets and a Gradle signing config.