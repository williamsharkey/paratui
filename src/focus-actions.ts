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
        ...(state.profile?.profile.user_name && state.profile.profile.user_name !== state.authUser?.handle
          ? [{ id: "open_dm", label: "Open DM" }]
          : []),
        { id: "open_creations", label: "Open Creations" },
        { id: "open_feed", label: "Open Feed" },
        { id: "open_settings", label: "Open Settings" }
      ];
    case "creation":
      return state.exports.lastSavedPath
        ? [
            { id: "toggle_preview", label: state.previewOpen ? "Hide Preview" : "Show Preview" },
            { id: "toggle_full_view", label: "Full" },
            { id: "comment_compose", label: "[+ comment]" },
            { id: "open_saved_art", label: "Open" },
            { id: "open_saved_folder", label: "Open Folder" }
          ]
        : [
            { id: "toggle_preview", label: state.previewOpen ? "Hide Preview" : "Show Preview" },
            { id: "toggle_full_view", label: "Full" },
            { id: "comment_compose", label: "[+ comment]" },
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
        { id: "dm_compose", label: "type here to dm" },
        { id: "open_active_profile", label: "Open Profile" },
        { id: "open_feed", label: "Open Feed" },
        { id: "open_settings", label: "Open Settings" }
      ];
    case "room":
      return [
        { id: "chat_compose", label: "type here to chat" },
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
