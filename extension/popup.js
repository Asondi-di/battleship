const GAME_PAGE_URL = chrome.runtime.getURL('game.html');
const GAME_WINDOW_KEY = 'battleshipGameWindowId';

const openGameBtn = document.getElementById('openGame');
openGameBtn.onclick = openGameWindow;

async function openGameWindow() {
    const { [GAME_WINDOW_KEY]: savedWindowId } = await chrome.storage.local.get(GAME_WINDOW_KEY);

    if (typeof savedWindowId === 'number') {
        try {
            const win = await chrome.windows.get(savedWindowId);
            if (win) {
                await chrome.windows.update(savedWindowId, { focused: true });
                return;
            }

        } catch (_) {
            // окно уже закрыто — создадим новое
        }
    }
    const createdWindow = await chrome.windows.create({
        url: GAME_PAGE_URL,
        type: 'popup',
        width: 1080,
        height: 920,
    });

    if (createdWindow?.id !== undefined) {
        await chrome.storage.local.set({ [GAME_WINDOW_KEY]: createdWindow.id });
    }
}

chrome.windows.onRemoved.addListener(async (windowId) => {
    const { [GAME_WINDOW_KEY]: savedWindowId } = await chrome.storage.local.get(GAME_WINDOW_KEY);
    if (windowId === savedWindowId) {
        await chrome.storage.local.remove(GAME_WINDOW_KEY);
    }
});