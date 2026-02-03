const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const statusTextEl = document.getElementById("statusText");
const errorEl = document.getElementById("error");

function setError(message) {
    if (!message) {
        errorEl.textContent = "";
        errorEl.style.display = "none";
        return;
    }
    errorEl.textContent = message;
    errorEl.style.display = "block";
}

function setBusy(isBusy) {
    sendBtn.disabled = isBusy;
    inputEl.disabled = isBusy;
    statusTextEl.textContent = isBusy ? "Thinking…" : "Ready";
}

function appendMessage(role, text, label) {
    const row = document.createElement("div");
    row.className = "bubble-row " + role;

    const bubble = document.createElement("div");
    bubble.className = "bubble " + role;

    if (role === "agent") {
        const labelEl = document.createElement("div");
        labelEl.className = "label";
        labelEl.textContent = label || "Agent";
        bubble.appendChild(labelEl);
    }

    bubble.appendChild(document.createTextNode(text));
    row.appendChild(bubble);
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function parseLogLine(line) {
    const idx = line.indexOf(":");
    if (idx > 0 && idx < 60) {
        const maybeLabel = line.slice(0, idx).trim();
        const remainder = line.slice(idx + 1).trim();
        if (maybeLabel && remainder) return { label: maybeLabel, text: remainder };
    }
    return { label: "Agent", text: line };
}

async function sendMessage() {
    const message = inputEl.value.trim();
    if (!message) return;

    setError("");
    appendMessage("user", message);
    inputEl.value = "";

    setBusy(true);

    const row = document.createElement("div");
    row.className = "bubble-row agent";

    const bubble = document.createElement("div");
    bubble.className = "bubble agent";

    const labelEl = document.createElement("div");
    labelEl.className = "label";
    labelEl.textContent = "Agent";
    bubble.appendChild(labelEl);

    const thinkingContainer = document.createElement("div");
    thinkingContainer.className = "thinking-container";

    const thinkingDetails = document.createElement("details");
    thinkingDetails.className = "thinking-details";
    thinkingDetails.open = true;

    const thinkingSummary = document.createElement("summary");
    thinkingSummary.className = "thinking-summary";
    thinkingSummary.textContent = "Reasoning";
    thinkingDetails.appendChild(thinkingSummary);

    const thinkingContent = document.createElement("div");
    thinkingContent.className = "thinking-content";
    thinkingDetails.appendChild(thinkingContent);

    thinkingContainer.appendChild(thinkingDetails);
    bubble.appendChild(thinkingContainer);

    const answerEl = document.createElement("div");
    answerEl.className = "answer-content";
    answerEl.textContent = "Thinking...";
    bubble.appendChild(answerEl);

    row.appendChild(bubble);
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    try {
        const res = await fetch("/api/agent/run", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
            },
            body: JSON.stringify({ query: message }),
        });

        if (!res.ok) {
            throw new Error(`Request failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (!line.trim()) continue;

                const match = line.match(/^event: (\w+)\ndata: (.+)$/s);
                if (!match) continue;

                const [, eventType, dataStr] = match;
                try {
                    const data = JSON.parse(dataStr);

                    if (eventType === "thinking") {
                        const message = data.message || "";
                        if (message) {
                            thinkingContent.textContent += (thinkingContent.textContent ? "\n" : "") + message;
                            messagesEl.scrollTop = messagesEl.scrollHeight;
                        }
                    } else if (eventType === "answer") {
                        const answer = data.answer || "";
                        if (answer) {
                            answerEl.textContent = answer;
                            messagesEl.scrollTop = messagesEl.scrollHeight;
                        }
                    } else if (eventType === "error") {
                        throw new Error(data.error || "Unknown error");
                    } else if (eventType === "done") {
                        if (thinkingContent.textContent.trim()) {
                            thinkingDetails.open = false;
                        } else {
                            thinkingContainer.remove();
                        }
                    }
                } catch (e) {
                    console.error("Failed to parse SSE data:", e);
                }
            }
        }
    } catch (err) {
        setError("Failed to contact agent. Please try again.");
        answerEl.textContent = "[Error: Failed to get response]";
    } finally {
        setBusy(false);
    }
}

sendBtn.addEventListener("click", sendMessage);

inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

statusTextEl.textContent = "Ready";
