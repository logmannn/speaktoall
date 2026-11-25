# Contributing

Thanks for helping. Speak To All is early-access and volunteer-run, so test
reports are as valuable as code.

## Reporting a test or a problem

[Open an issue](../../issues/new/choose) and pick **Test report** or **Bug report**.
Include your operating system, how listeners connected (phones, projector, OBS),
the languages used, and roughly how long it ran. Never paste API keys; the app
never needs them in a report.

## Making changes

```sh
npm install
npm start     # runs the app from source (keys stay out of the keychain)
npm test      # fake providers; spends no API credits
```

- Keep pull requests focused on one change and add or update tests in `test/`.
- Write the first line of each commit for the people using the app, such as
  "Add Portuguese voice" or "Fix captions freezing after WiFi drops". Commit
  messages become the release notes shown in the app's update notice.
- The app must keep running entirely on the user's computer with their own keys.
  Please don't add accounts, tracking, or servers in between.

See the Development section of the [README](README.md#development) for where
things live.
