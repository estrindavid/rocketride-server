# RocketRide Voice Builder

Voice Builder adds a microphone workflow to the RocketRide VS Code canvas. It is inspired by YapDraw's live voice loop, but it targets RocketRide `.pipe` projects instead of drawings.

## What It Does

- Streams microphone audio from the canvas toolbar to Deepgram.
- Turns completed utterances into project edits through a host-side planner.
- Applies the returned project with the existing canvas load and dirty-state path.
- Lets the user revert the most recent voice-generated edit.
- Tracks local usage counts in VS Code workspace state for hackathon/demo validation.

## Required Environment

Set these variables in the VS Code extension host environment before launching the extension:

```bash
export DEEPGRAM_API_KEY="..."
export DEEPGRAM_PROJECT_ID="..."
```

Voice Builder first tries to mint a short-lived Deepgram key. For local demos, if the configured Deepgram key cannot create keys because it lacks `keys:write`, the extension falls back to using `DEEPGRAM_API_KEY` directly for the live websocket. Set `VOICE_BUILDER_ALLOW_DEEPGRAM_API_KEY_FALLBACK=false` to disable that fallback.

For the project edit planner, either use the default Groq-compatible path:

```bash
export GROQ_API_KEY="..."
```

Or provide an OpenAI-compatible endpoint explicitly:

```bash
export VOICE_BUILDER_API_KEY="..."
export VOICE_BUILDER_BASE_URL="https://your-openai-compatible-endpoint/v1"
export VOICE_BUILDER_MODEL="your-model"
```

When these values are missing, the mic still appears in the toolbar, but the panel shows the first setup error and does not start recording.

## Run Locally

1. Export the Voice Builder environment variables in the shell that launches VS Code.

   ```bash
   export DEEPGRAM_API_KEY="..."
   export DEEPGRAM_PROJECT_ID="..."
   export GROQ_API_KEY="..."
   code .
   ```

2. Build and stage the extension.

   ```bash
   ./builder vscode:compile --verbose
   ./builder vscode:stage-files --verbose
   ```

   `vscode:stage-files` is required because it copies the extension manifest into `build/vscode`. Without it, VS Code can fall back to an installed Marketplace extension.

3. In VS Code, open **Run and Debug** and launch **VSCode Extension (with build)**.

   The debug profile starts an Extension Development Host from:

   ```text
   build/vscode
   ```

4. In the Extension Development Host, open a workspace with a `.pipe` file and use the RocketRide visual editor.

## Demo Flow

1. Open a `.pipe` file in the RocketRide visual editor.
2. Click the microphone button in the canvas toolbar.
3. Speak a short command, for example:

   ```text
   Add an OpenAI LLM after the chat source and connect it to a response node.
   ```

4. Wait for the panel to show `Applying`, then review the applied summary.
5. Use the undo arrow in the panel to revert the last voice-generated edit if needed.
6. Save the pipeline normally with the existing canvas save button.

## Usage Metric

The VS Code host records aggregate local metrics under:

```text
rocketride.voiceBuilder.metrics
```

Tracked counters include:

- `sessionStarted`
- `sessionStopped`
- `utteranceCompleted`
- `editApplied`
- `editFailed`
- `editReverted`
- total transcript characters
- total applied component count

These metrics stay local in VS Code workspace state and are intended for demo validation, not product analytics.

## Implementation Notes

- Browser secrets never enter the webview bundle.
- Deepgram keys are short-lived temporary keys minted by the extension host when the configured key has `keys:write`. Local demos can fall back to the configured Deepgram API key.
- The planner must return JSON shaped as:

  ```json
  {
    "project": {},
    "summary": "short change summary"
  }
  ```

- The generated project must preserve `project_id`.
- The canvas strips viewport state from voice-generated document content before notifying the host.
