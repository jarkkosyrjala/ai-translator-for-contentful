# Editor guide

AI Translator suggests translations. You decide what is written, and only to the entry's draft. Publishing stays with you.

## Translate

1. Open an entry and select **Translate entry** in the AI Translator sidebar. The button is available when the entry has a translatable field with text.
2. Under **Translate from**, check the source locale. It starts with the locale you were editing, your saved default, or the space's default locale.
3. Under **Translate into**, choose one or more target locales. In both sections, **Save as my default** remembers the choice in this browser.
4. Under **Fields**, choose the fields to translate, or use **Select all**. The list contains localized Short text, Long text, Short text list, and Rich Text fields that use Contentful's standard editors and have text in the source locale. Fields with predefined values or a pattern validation are not offered.
5. Optional: open **Guidance and context**.
   - **Guidance for this run** is sent with every field in this run, for example "Use informal address."
   - Fill in any variables your administrator defined. Required variables must be filled in before you can translate.
   - Add context: **From this entry** adds fields of this entry, and **Search other entries** finds a saved entry; pick its fields under **Add a field from a loaded entry**. Context helps with names and terminology; it is not translated. By default up to 8 context fields and 6,000 characters are sent; your administrator can change this per model. A context field cut short or left out is marked.
6. Select **Translate**. The footer shows how many suggestions you will get and how many requests that takes.

The dialog names the model, and with a Custom backend the provider, that the translation goes to. If your administrator enabled more than one, open **Advanced settings** to choose another for this dialog. Changing it clears suggestions you have not applied. Select **Save as my default** to start with that choice next time in this browser; it is saved when you select **Translate**. Otherwise, the next time you open AI Translator, it starts with the installation's default again. A saved choice that is no longer enabled is ignored. If a field shows “This choice is no longer available”, close and reopen AI Translator, or ask a space admin to check the app configuration.

The source is what you see in the editor now, including changes you haven't saved. Context from other entries uses their saved values.

Fields are translated together: each request carries several fields of the entry into one language, in the order of the content type, so the model sees them side by side and keeps terms consistent. A selected field that goes in another request is sent along as context. A large list or Rich Text field is split into parts, each with its headings and the neighboring text as context; the parts are checked and joined before you review the field. A note under the guidance explains when a field is larger than the request size or may take longer than the service allows.

### Translate one field

If your administrator added AI Translator to a field, a **Translate** button appears under its label, or beside the **Editor** and **Preview** tabs in a Markdown field. Select it to translate that field from the locale you are editing. The dialog shows that field and source locale as fixed; choose the target locales, add optional guidance and context, and select **Translate**. In multi-locale view each locale has its own button. The button is unavailable while the field is empty in that locale.

## Review

Each target locale has its own tab. Each field gets a row with the source, the current value, and the suggestion.

- A valid suggestion starts on **Use new**; a failed or unsafe suggestion stays on **Keep current**. **Use all new** selects every usable suggestion in the tab. Review each choice before applying.
- Edit text and list suggestions in the row. For Long text, **Expand** opens the suggestion in Contentful's Markdown or Multiple line editor. For Rich Text, **Edit text** opens it in Contentful's Rich Text editor. **Restore generated text** undoes your edits.
- **Retry** repeats a failed or stopped field with the same parts, and **Retry failed** does this for every failed field. After a timeout, a cut-off answer, or a size limit, **Retry in smaller batches** sends the field on its own, split into smaller parts where it has paragraphs, list items, or blocks to split at. Before it starts, it shows how many requests it sends; each is a separate model call, and parts translated separately can differ slightly in wording. Parts that already finished are kept. A field with nothing to split at says so; ask your administrator to raise the model's timeout or output allowance.
- **Stop** discards the request in progress and skips the remaining ones; finished suggestions remain. A model call that has already started may still run to the end at the provider, and its usage may still be charged.
- A suggestion depends on the source and current value of its field and on every value sent with it. If one of them changes in the entry editor while the dialog is open, the row says so; go **Back** and translate again.

The app checks the field's length and item limits. **Use new** stays unavailable while a suggestion breaks a limit, until you fix it or translate again. A suggestion more than twice the field's limit is treated as failed. The app also checks that placeholders, URLs, identifiers, and leading or trailing whitespace and line breaks are kept. If a suggestion or your edit changes one, the row shows a warning; select **Approve this change** to use that exact text, or **Restore generated text** to undo your edits. If text such as `&amp;` changed, the row shows a warning but lets you use the suggestion. Whether the translation is right is your call.

For Rich Text, the app also checks the document structure and the field's allowed formatting. Link text is translated; link targets, embedded entries and assets, and code text stay as they are. If a suggestion or your edit changes a link, embed, horizontal rule, code text, line break, placeholder, URL, or identifier, the row shows the same warning and **Approve this change**.

### Another translation of the same entry

With a Custom backend, one translation request per entry runs at a time. If another request for the same entry is running, for example from a colleague, the app waits and retries automatically for up to two minutes. Translations for other entries continue. A new translation can start as soon as the earlier request finishes, even while its suggestion is still being reviewed. If the wait ends first, the row explains the conflict and offers **Retry**.

## Apply

**Apply** writes the rows marked **Use new** to the draft. The app first reads the entry again. A value that changed in the editor since translation is not written, and the result says so. The sidebar then lists which values were written, kept, or not written and why, and says "Nothing was published." A run started from a field shows a notification with the number of values written and any that were not. Review the entry and publish it as usual.

## What gets sent

The selected fields, your guidance, the chosen context, and the administrator's instructions are sent to the translation service your organization configured. See [Privacy and data flow](privacy.md). If your administrator turns on Debug mode, **What gets sent** in the dialog shows the destination, the model, the request size, and for each request its fields, size, context, and the messages it sends to the model. A retry shows its messages before it starts.
