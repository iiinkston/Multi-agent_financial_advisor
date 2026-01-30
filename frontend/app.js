const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const statusTextEl = document.getElementById("statusText");
const errorEl = document.getElementById("error");

function appendMessage(role, text) {
    const row = document.createElement("div");
    row.className = "bubble-row " + role;

    const bubble = document.createElement("div");
    bubble.className = "bubble " + role;

    if (role === "agent") {
        const label = document.createElement("div");
        label.className = "label";
        label.textContent = "Agent";
        bubble.appendChild(label);
    }

    bubble.appendChild(document.createTextNode(text));
    row.appendChild(bubble);
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function sendMessage() {
    const message = inputEl.value.trim();
    if (!message) return;

    appendMessage("user", message);
    inputEl.value = "";

    sendBtn.disabled = true;
    statusTextEl.textContent = "Thinking…";

    try {
        const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message }),
        });

        const data = await res.json();
        appendMessage("agent", data.reply || "[Empty reply]");
    } catch (err) {
        errorEl.textContent = "Failed to contact agent.";
        errorEl.style.display = "block";
    } finally {
        sendBtn.disabled = false;
        statusTextEl.textContent = "Ready";
    }
}

sendBtn.addEventListener("click", sendMessage);

inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});
