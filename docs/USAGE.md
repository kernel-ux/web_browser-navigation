# GhostGuide Usage Guide

This guide walks you through installation, setup, and daily use in plain steps.

## 1) Install the Extension (Local)

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select this project folder.
5. Open the **GhostGuide** side panel from the Chrome toolbar.

## 2) Add Your API Key

1. Click **Settings** (⚙️) inside the panel.
2. Choose a provider (Gemini, OpenAI, Anthropic, Groq, DeepSeek, OpenRouter, Custom).
3. Paste your API key.
4. Click **Test Connection**.
5. Click **Save & Close**.

See `docs/API_SETUP.txt` for provider links and model defaults.

## 3) Use GhostGuide

1. Open any website.
2. In the GhostGuide panel, type a clear goal.
3. Click **Start**.
4. Follow the highlighted action on the page.
5. Click **Done** to confirm each step.
6. If GhostGuide says it’s finished, choose **Finished** or **Not finished** and continue.

Examples of good goals:
- “Find the pricing page”
- “Log in to my account”
- “Search for noise‑canceling headphones”
- “Get my API key”

## Tips

- If you’re on a blocked page (`chrome://` or new tab), open a normal website and retry.
- If a step fails, click **Done** and write a short correction (e.g., “button says Continue”).
- For search tasks, GhostGuide may highlight the search box and ask you to press Enter.

## Troubleshooting

- **Nothing happens after Start**: reload the page and click Start again.
- **Scan timed out**: open a simpler page or refresh.
- **API errors**: check your API key, provider, and model name.
- **Debugging**: open the Chrome extension console and check logs.
