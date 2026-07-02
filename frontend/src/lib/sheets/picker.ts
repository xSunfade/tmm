import { getTokenForPicker } from './api';

declare global {
  interface Window {
    gapi?: {
      load: (name: string, callback: () => void) => void;
    };
    google?: {
      picker?: {
        PickerBuilder: new () => PickerBuilder;
        ViewId: { SPREADSHEETS: string };
        Action: { PICKED: string };
        Document?: { ID: string };
        DocsView: new (viewId?: string) => DocsView;
        DocsViewMode?: { LIST: string };
      };
    };
  }
}

interface PickerBuilder {
  addView(view: DocsView): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setCallback(callback: (data: PickerResponse) => void): PickerBuilder;
  setAppId?(appId: string): PickerBuilder;
  build(): Picker;
}

interface DocsView {
  setMimeTypes(mimeType: string): DocsView;
  setMode?(mode: string): DocsView;
}

interface Picker {
  setVisible(visible: boolean): void;
}

interface PickerResponse {
  action: string;
  docs?: Array<{ id: string }>;
}

function loadPickerApi(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('Picker requires browser environment'));
      return;
    }
    const gapi = window.gapi;
    if (!gapi) {
      reject(new Error('Google API not loaded. Ensure apis.google.com/js/api.js is included.'));
      return;
    }
    gapi.load('picker', () => {
      resolve();
    });
  });
}

/**
 * Opens the Google Drive Picker dialog filtered to spreadsheets only.
 * Returns the selected spreadsheet ID, or null if cancelled.
 */
export async function openGoogleSheetsPicker(): Promise<string | null> {
  await loadPickerApi();

  const picker = window.google?.picker;
  if (!picker) {
    throw new Error('Google Picker API not available');
  }

  const accessToken = await getTokenForPicker();

  const appId = import.meta.env.VITE_GOOGLE_APP_ID as string | undefined;

  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.SPREADSHEETS);
    view.setMimeTypes('application/vnd.google-apps.spreadsheet');
    // drive.file scope doesn't grant thumbnail access; LIST avoids 403s
    if (picker.DocsViewMode?.LIST) {
      view.setMode?.(picker.DocsViewMode.LIST);
    }

    const builder = new picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(accessToken)
      .setCallback((data: PickerResponse) => {
        const raw = data as unknown as Record<string, unknown>;
        const action = data.action ?? raw.action;
        const actionStr = String(action ?? '');
        // Picker fires callback multiple times: "loaded" when dialog opens, then "picked" or "cancel" when user acts. Only resolve on user action.
        const isPicked =
          action === picker.Action?.PICKED ||
          action === 'picked' ||
          String(action) === '1';
        const isCancel = action === 'cancel' || String(action) === '2';
        if (actionStr === 'loaded' || (!isPicked && !isCancel)) {
          return;
        }
        let resolvedId: string | null = null;
        if (isPicked) {
          const docs = raw.docs ?? raw.documents ?? data.docs;
          const docsArr = Array.isArray(docs) ? docs : [];
          if (docsArr.length) {
            const doc = docsArr[0] as Record<string, unknown>;
            const idKey = picker.Document?.ID ?? 'id';
            const id = doc?.id ?? doc?.['id'] ?? doc?.[idKey];
            resolvedId = typeof id === 'string' ? id : null;
          }
        }
        resolve(resolvedId);
      });

    if (appId) {
      builder.setAppId?.(appId);
    }

    const pickerInstance = builder.build();
    pickerInstance.setVisible(true);
  });
}
