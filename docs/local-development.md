# Local development

For local development, Contentful loads the app's frontend from your computer instead of an uploaded bundle. On the App Definition's **App details** page, turn off **Hosted by Contentful**, set the frontend URL to the local server, and click **Save**. Then start the server and reload an entry.

```sh
pnpm dev         # http://localhost:3000, for Chrome and Firefox
pnpm dev:https   # https://localhost:3000, for Safari
```

Opening the server's URL in its own tab shows a short info page. It never appears inside Contentful.

To use the uploaded bundle again, turn **Hosted by Contentful** back on and save. The frontend URL setting affects every installation of the App Definition, so use a separate App Definition for development.

To run a backend locally as well, see the local development section of the [Worker](cloudflare-worker.md#local-development) or [Azure](azure-functions.md#local-development) guide.

## Which browsers need HTTPS

Contentful runs on HTTPS, so a frame from `http://localhost` is mixed content.

- **Chrome and Firefox** treat `http://localhost` as secure and load the frame. Use `pnpm dev`.
- **Safari** and other WebKit browsers block it. Contentful then reports `iframe http://localhost:3000/ is unresponsive` and the app area stays empty. `127.0.0.1`, `[::1]`, and `*.localhost` are blocked too, so use `pnpm dev:https`.

## HTTPS for Safari

`pnpm dev:https` serves a self-signed certificate made by [`@vitejs/plugin-basic-ssl`](https://github.com/vitejs/vite-plugin-basic-ssl). The project keeps it in `apps/contentful-app/.cert/`, which Git ignores, and makes it valid for 825 days, the [longest validity macOS accepts](https://support.apple.com/en-us/103769).

1. Run `pnpm dev:https`.
2. Set the App Definition's frontend URL to `https://localhost:3000`. Switch it back to `http://localhost:3000` when you use `pnpm dev` again.
3. Trust the certificate once: open `https://localhost:3000` in Safari. On **This Connection Is Not Private**, click the **visit this website** link at the end. The info page then says the development server is running, and Contentful's frame loads too. Safari remembers this exception after it restarts, until the certificate changes.
4. Reload the entry in Contentful.

## Troubleshooting

- **The frame is empty or "unresponsive" in Safari.** Inside Contentful, a certificate problem shows no warning; the frame just fails. Open `https://localhost:3000` in its own tab. If Safari warns about the connection, repeat step 3.
- **A new certificate.** The plugin makes a new one when the old one expires or `apps/contentful-app/.cert/` is deleted. Trust it again (step 3). Old ones appear in Keychain Access as **AI Translator for Contentful development** and can be deleted there.
- **The frame loads but backend calls fail.** Select **Test connection** on the configuration screen, then see the troubleshooting section of your backend guide: [Worker](cloudflare-worker.md#troubleshooting), [Azure](azure-functions.md#troubleshooting), [AWS](aws-lambda.md#troubleshooting), or [Contentful Function](contentful-function.md#troubleshooting).
