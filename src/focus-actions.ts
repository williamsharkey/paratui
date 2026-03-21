import type { AppState, FocusRegion } from "./types.js";

export interface FocusAction {
  id: string;
  label: string;
}

export function getFocusActions(state: AppState, focus: FocusRegion = state.focus): FocusAction[] {
  if (!state.authUser || state.view === "login" || focus === "auth") {
    return [
      { id: "open_api_help", label: "Open API Page" },
      { id: "paste_api_key", label: "Paste API Key" }
    ];
  }

  if (focus === "settings") {
    return [
      { id: "toggle_mute", label: state.config.audio.muted ? "Enable Sounds" : "Mute Sounds" }
    ];
  }

  if (focus !== "center") {
    return [];
  }

  switch (state.view) {
    case "profile":
      return [
        { id: "open_creations", label: "Open Creations" },
        { id: "open_feed", label: "Open Feed" },
        { id: "open_settings", label: "Open Settings" }
      ];
    case "creation":
      return [
        { id: "toggle_preview", label: state.previewOpen ? "Hide Preview" : "Show Preview" },
        { id: "previous_art", label: "Previous Art" },
        { id: "next_art", label: "Next Art" },
        { id: "save_art", label: "Save PNG" }
      ];
    case "feed":
      return [
        { id: "previous_feed", label: "Previous Feed" },
        { id: "next_feed", label: "Next Feed" },
        { id: "open_settings", label: "Open Settings" }
      ];
    case "dm":
      return [
        { id: "open_active_profile", label: "Open Profile" },
        { id: "open_feed", label: "Open Feed" },
        { id: "open_settings", label: "Open Settings" }
      ];
    case "room":
      return [
        { id: "open_feed", label: "Open Feed" },
        { id: "open_settings", label: "Open Settings" }
      ];
    case "live":
      return [
        { id: state.realtime.connected ? "disconnect_live" : "connect_live", label: state.realtime.connected ? "Disconnect Live" : "Connect Live" },
        { id: "join_lobby", label: "Join Lobby" },
        { id: "open_settings", label: "Open Settings" }
      ];
    default:
      return [];
  }
}
