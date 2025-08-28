import React, { useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { MapContainer, TileLayer, Marker, Circle, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/**
 * GALAMSEY REPORTER (MVP++) — Advanced Features
 * - Stealth mode, Upload-When-Safe, EXIF scrub, Checklist mode, SMS/USSD fallback
 * - Private/Public map view with blur radius, distance, fit-to-bounds
 * - Offline-first local storage + simulated status progression
 */

// ---- Leaflet marker fix ----
const DefaultIcon = new L.Icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});
(L.Marker.prototype as any).options.icon = DefaultIcon;

// ---- Utilities ----
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const km = (m: number) => (m / 1000).toFixed(2);
const toRad = (d: number) => (d * Math.PI) / 180;
const haversine = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const R = 6371e3;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};
function randomPointInRing(lat: number, lon: number, minM: number, maxM: number) {
  const bearing = Math.random() * 2 * Math.PI;
  const d = minM + Math.random() * (maxM - minM);
  const R = 6371e3, φ1 = toRad(lat), λ1 = toRad(lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d / R) + Math.cos(φ1) * Math.sin(d / R) * Math.cos(bearing));
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(d / R) * Math.cos(φ1),
      Math.cos(d / R) - Math.sin(φ1) * Math.sin(φ2)
    );
  return { lat: (φ2 * 180) / Math.PI, lon: (λ2 * 180) / Math.PI };
}
function pointsKey(points: number[][]) {
  return points
    .filter((p) => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]))
    .map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`)
    .join("|");
}
function FitToBounds({ points }: { points: number[][] }) {
  const map = useMap();
  const sig = useMemo(() => pointsKey(points), [points]);
  useEffect(() => {
    if (!map || points.length === 0) return;
    const latlngs = points.map((p) => L.latLng(p[0], p[1]));
    if (latlngs.length === 1) map.setView(latlngs[0], 15, { animate: true });
    else map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40] });
  }, [map, sig]);
  return null;
}

// ---- Storage ----
const LS_REPORTS = "galamsey_reports_v2";
const LS_SETTINGS = "galamsey_settings_v2";
const loadReports = () => {
  try { return JSON.parse(localStorage.getItem(LS_REPORTS) || "[]"); } catch { return []; }
};
const saveReports = (r: any[]) => localStorage.setItem(LS_REPORTS, JSON.stringify(r));
const loadSettings = () => {
  try {
    return JSON.parse(
      localStorage.getItem(LS_SETTINGS) ||
        JSON.stringify({ authority: { sms: "", ussd: "" }, safe: { minMeters: 1000, maxWaitMins: 30 } })
    );
  } catch {
    return { authority: { sms: "", ussd: "" }, safe: { minMeters: 1000, maxWaitMins: 30 } };
  }
};
const saveSettings = (s: any) => localStorage.setItem(LS_SETTINGS, JSON.stringify(s));

// ---- Status machine ----
const STATUSES = ["Queued", "Submitted", "Received", "In Progress", "Resolved"] as const;

// ---- Client-side EXIF scrub (re-encode image via Canvas) ----
async function sanitizeImage(file: File, maxDim = 1600) {
  const dataUrl = await new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result as string);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = dataUrl;
  });
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  // JPEG unless original is PNG
  const isPng = (file.type || "").includes("png");
  return canvas.toDataURL(isPng ? "image/png" : "image/jpeg", 0.92);
}

// ---- Types ----
type Media = { type: "image" | "video" | "audio"; name: string; dataUrl: string; locked?: boolean };
type Contact = { phone: string | null; email: string | null; wantsCallback: boolean; preferredTime: string | null } | null;
type SafeUpload = { required: boolean; ready: boolean; captureLoc?: { lat: number; lon: number }; createdAt?: string };

type Report = {
  id: string;
  createdAt: string;
  category: string;
  description: string;
  gps: { lat: number; lon: number; accuracy?: number };
  blurRadius: number;
  publicOffset: { lat: number; lon: number };
  media: Media[];
  anonymous: boolean;
  contact: Contact;
  rewardOptIn: boolean;
  status: (typeof STATUSES)[number] | string;
  history: { state: string; at: string }[];
  safeUpload: SafeUpload;
};

// ---- App ----
export default function App() {
  // global
  const [tab, setTab] = useState<"report" | "my" | "map" | "help" | "settings">("report");
  const [reports, setReports] = useState<Report[]>(loadReports());
  const [online, setOnline] = useState<boolean>(typeof navigator !== "undefined" ? navigator.onLine : true);
  const [userLoc, setUserLoc] = useState<null | { lat: number; lon: number; accuracy?: number }>(null);
  const [privateView, setPrivateView] = useState(true);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [settings, setSettings] = useState<any>(loadSettings());

  useEffect(() => saveReports(reports), [reports]);
  useEffect(() => saveSettings(settings), [settings]);

  // online/offline
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  // geolocation
  const watchId = useRef<number | null>(null);
  const getUserLoc = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setUserLoc({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 12000 }
    );
  };
  useEffect(() => { getUserLoc(); }, []);
  useEffect(() => {
    if (!navigator.geolocation) return;
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => setUserLoc({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    ) as unknown as number;
    return () => { if (watchId.current && (navigator.geolocation as any).clearWatch) (navigator.geolocation as any).clearWatch(watchId.current); };
  }, []);

  // form
  const [form, setForm] = useState<any>({
    category: "",
    description: "",
    gps: null as null | { lat: number; lon: number; accuracy?: number },
    blurRadius: 300,
    anonymous: true,
    contact: { phone: "", email: "", wantsCallback: false, preferredTime: "" },
    rewardOptIn: false,
    media: [] as Media[],
    stealth: false,
    uploadWhenSafe: true,
    checklistMode: false,
    checklist: { types: {} as Record<string, boolean>, hazards: {} as Record<string, boolean>, time: "", risk: "" },
  });

  // upload-when-safe check
  const isSafeToUpload = (r: Report, loc: { lat: number; lon: number } | null, now = Date.now()) => {
    if (!r.safeUpload?.required) return true;
    const minMeters = settings.safe?.minMeters ?? 1000;
    const maxWaitMs = (settings.safe?.maxWaitMins ?? 30) * 60 * 1000;
    const created = new Date(r.createdAt).getTime();
    if (now - created >= maxWaitMs) return true;
    if (!loc) return false;
    const d = haversine(loc.lat, loc.lon, r.safeUpload.captureLoc!.lat, r.safeUpload.captureLoc!.lon);
    return d >= minMeters;
  };

  // poll readiness every 30s
  useEffect(() => {
    const h = setInterval(() => {
      setReports((prev) =>
        prev.map((r) =>
          r.safeUpload?.required && !r.safeUpload.ready && isSafeToUpload(r, userLoc)
            ? { ...r, safeUpload: { ...r.safeUpload, ready: true } }
            : r
        )
      );
    }, 30000);
    return () => clearInterval(h);
  }, [userLoc?.lat, userLoc?.lon, settings.safe?.minMeters, settings.safe?.maxWaitMins]);

  // file handlers
  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>, type: Media["type"]) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      let dataUrl: string;
      if (type === "image") dataUrl = await sanitizeImage(file); // EXIF stripped
      else {
        dataUrl = await new Promise<string>((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result as string);
          fr.onerror = rej;
          fr.readAsDataURL(file);
        });
      }
      const media: Media = { type, name: file.name, dataUrl, locked: form.uploadWhenSafe || form.stealth };
      setForm((f: any) => ({ ...f, media: [...f.media, media] }));
    } catch {
      alert("Could not process file. Try a smaller file.");
    } finally {
      e.target.value = "";
    }
  };
  const removeMedia = (i: number) => setForm((f: any) => ({ ...f, media: f.media.filter((_: any, idx: number) => idx !== i) }));

  // checklist -> description helper
  const checklistText = (chk: any) => {
    const sel = (o: Record<string, boolean>) => Object.keys(o).filter((k) => o[k]);
    const t = sel(chk.types).join(", ") || "(none)";
    const h = sel(chk.hazards).join(", ") || "(none)";
    return `Checklist report — Types: ${t}. Hazards: ${h}. Time: ${chk.time || "unspecified"}. Risk: ${chk.risk || "unspecified"}.`;
  };

  // submit
  const submitReport = () => {
    const autoDesc = form.checklistMode ? checklistText(form.checklist) : "";
    const finalDesc = [autoDesc, form.description].filter(Boolean).join("\n");
    if (!(form.category || form.checklistMode) || !finalDesc || !form.gps) {
      alert("Please choose a category (or use Checklist), add a description, and capture GPS.");
      return;
    }
    const id = uuidv4();
    const { lat, lon } = form.gps;
    const br = clamp(Number(form.blurRadius || 0), 0, 2000);
    const offset = br > 0 ? randomPointInRing(lat, lon, Math.max(1, br * 0.5), br) : { lat, lon };
    const nowIso = new Date().toISOString();

    const r: Report = {
      id,
      createdAt: nowIso,
      category: form.category || "(checklist)",
      description: finalDesc,
      gps: form.gps,
      blurRadius: br,
      publicOffset: offset,
      media: form.media,
      anonymous: form.anonymous,
      contact: form.anonymous
        ? null
        : {
            phone: form.contact.phone || null,
            email: form.contact.email || null,
            wantsCallback: !!form.contact.wantsCallback,
            preferredTime: form.contact.preferredTime || null,
          },
      rewardOptIn: !form.anonymous && !!form.rewardOptIn,
      status: online ? "Submitted" : "Queued",
      history: [{ state: online ? "Submitted" : "Queued", at: nowIso }],
      safeUpload: form.uploadWhenSafe || form.stealth
        ? { required: true, ready: false, captureLoc: { lat, lon }, createdAt: nowIso }
        : { required: false, ready: true },
    };
    setReports((prev) => [r, ...prev]);

    // reset
    setForm({
      category: "", description: "", gps: null, blurRadius: 300, anonymous: true,
      contact: { phone: "", email: "", wantsCallback: false, preferredTime: "" },
      rewardOptIn: false, media: [], stealth: false, uploadWhenSafe: true,
      checklistMode: false, checklist: { types: {}, hazards: {}, time: "", risk: "" },
    });
    setTab("my");
  };

  // manual sync simulator (respects safe upload)
  const manualSync = () => {
    if (!online) { alert("You are offline. Try again when connected."); return; }
    const now = Date.now();
    setReports((prev) =>
      prev.map((r) => {
        if (r.status === "Queued" || r.status === "Submitted") {
          if (isSafeToUpload(r, userLoc, now)) {
            if (r.status === "Queued") {
              const at = new Date().toISOString();
              return { ...r, status: "Submitted", history: [...r.history, { state: "Submitted", at }], safeUpload: { ...r.safeUpload, ready: true } };
            }
          }
        }
        return r;
      })
    );
    // Submitted -> Received (demo)
    setTimeout(() => {
      setReports((prev) =>
        prev.map((r) =>
          r.status === "Submitted" ? { ...r, status: "Received", history: [...r.history, { state: "Received", at: new Date().toISOString() }] } : r
        )
      );
    }, 1200);
  };

  // export & sms/ussd
  const exportJSON = (r: Report) => {
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `report_${r.id}.json`; a.click();
    URL.revokeObjectURL(url);
  };
  const buildSMS = (r: Report) => {
    const when = new Date(r.createdAt).toLocaleString();
    const loc = `${r.gps.lat.toFixed(5)}, ${r.gps.lon.toFixed(5)} (±${Math.round(r.gps.accuracy || 0)}m)`;
    const txt = `Galamsey Report\nCategory: ${r.category}\nWhen: ${when}\nWhere: ${loc}\nDetails: ${r.description.slice(0, 350)}`;
    return encodeURIComponent(txt);
  };
  const openSMS = (r: Report) => {
    if (!settings.authority?.sms) { alert("Set an SMS number in Settings first."); return; }
    window.location.href = `sms:${settings.authority.sms}?&body=${buildSMS(r)}`;
  };

  // ---- UI primitives ----
  const Badge = ({ online }: { online: boolean }) => (
    <div className="flex items-center gap-2 text-sm">
      <span className={`inline-block w-2.5 h-2.5 rounded-full ${online ? "bg-green-500" : "bg-gray-400"}`} />
      <span className="text-gray-700">{online ? "Online" : "Offline"}</span>
    </div>
  );
  const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
    <section className="bg-white rounded-2xl shadow p-4 sm:p-6 mb-5">
      <h2 className="text-lg sm:text-xl font-semibold mb-3">{title}</h2>
      {children}
    </section>
  );
  const Timeline = ({ status }: { status: string }) => (
    <div className="flex items-center gap-2 flex-wrap text-xs">
      {STATUSES.map((s, idx) => (
        <div key={s} className="flex items-center gap-2">
          <div className={`px-2 py-1 rounded ${STATUSES.indexOf(status as any) >= idx ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"}`}>{s}</div>
          {idx < STATUSES.length - 1 && <div className="h-px w-6 bg-gray-300" />}
        </div>
      ))}
    </div>
  );
  const SafetyNotes = () => (
    <ul className="list-disc pl-5 text-sm text-gray-700 space-y-1">
      <li><b>Do not confront miners.</b> Keep your distance; your safety is first.</li>
      <li>Capture <b>landmarks</b> (bridges, bends) rather than faces/plates.</li>
      <li>Use a <b>blur radius</b> so the public map hides exact points.</li>
      <li>You are <b>anonymous by default</b>. Share contact only if you want follow-up/reward.</li>
    </ul>
  );

  // ---- Screens ----
  const Header = () => (
    <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b">
      <div className="max-w-7xl mx-auto px-3 py-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-base sm:text-lg">Galamsey Reporter (MVP++)</span>
          <span className="hidden sm:inline text-xs text-gray-500">Privacy-by-design • Offline-first</span>
        </div>
        <div className="flex items-center gap-4">
          <Badge online={online} />
          <button onClick={manualSync} className="text-sm px-3 py-1.5 rounded-xl bg-black text-white hover:opacity-90">Sync</button>
        </div>
      </div>
      <nav className="max-w-7xl mx-auto px-3 flex gap-1 pb-2 flex-wrap">
        {[
          { k: "report", label: "New Report" },
          { k: "my", label: "My Reports" },
          { k: "map", label: "Map" },
          { k: "help", label: "Help & Safety" },
          { k: "settings", label: "Settings" },
        ].map((t) => (
          <button key={t.k} onClick={() => setTab(t.k as any)} className={`px-3 py-1.5 rounded-xl text-sm ${tab === (t.k as any) ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-700"}`}>{t.label}</button>
        ))}
      </nav>
    </header>
  );

  const NewReport = () => (
    <div className="max-w-7xl mx-auto px-3 py-4">
      <Section title="Reporting Form">
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium">Category</label>
            <select className="mt-1 w-full rounded-xl border px-3 py-2" value={form.category} onChange={(e) => setForm((f: any) => ({ ...f, category: e.target.value }))}>
              <option value="">Select…</option>
              <option>River dredging</option>
              <option>Excavator in reserve</option>
              <option>Chemical use</option>
              <option>Night trucking</option>
              <option>Pit hazard near school</option>
              <option>Other</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium">GPS Location</label>
            <div className="mt-1 flex items-center gap-2">
              <button onClick={getUserLoc} className="px-3 py-2 rounded-xl bg-gray-900 text-white">Use My Location</button>
              {form.gps ? (
                <span className="text-sm text-gray-700">{form.gps.lat.toFixed(5)}, {form.gps.lon.toFixed(5)} • ±{Math.round(form.gps.accuracy || 0)} m</span>
              ) : (
                <span className="text-sm text-gray-500">No location yet</span>
              )}
            </div>
          </div>
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium">Description</label>
            <textarea className="mt-1 w-full rounded-xl border px-3 py-2 min-h-[100px]" placeholder="What did you see? When? Any landmarks?" value={form.description} onChange={(e) => setForm((f: any) => ({ ...f, description: e.target.value }))} />
          </div>
        </div>

        {/* Checklist Mode */}
        <div className="mt-4 p-3 rounded-xl bg-gray-50 border">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={form.checklistMode} onChange={(e) => setForm((f: any) => ({ ...f, checklistMode: e.target.checked }))} />
            Use Simple Checklist Mode (low literacy)
          </label>
          {form.checklistMode && (
            <div className="mt-3 grid sm:grid-cols-3 gap-4 text-sm">
              <div>
                <div className="font-medium mb-1">Activity type</div>
                {[
                  ["riverDredging","River dredging"],
                  ["excavator","Excavator in reserve"],
                  ["chemical","Chemical use"],
                  ["trucking","Night trucking"],
                  ["pitHazard","Pit hazard"],
                  ["other","Other"],
                ].map(([k,label]) => (
                  <label key={k} className="flex items-center gap-2 mb-1">
                    <input type="checkbox" checked={!!form.checklist.types[k]} onChange={(e)=>setForm((f: any)=>({ ...f, checklist:{ ...f.checklist, types:{ ...f.checklist.types, [k]: e.target.checked }}}))} /> {label}
                  </label>
                ))}
              </div>
              <div>
                <div className="font-medium mb-1">Hazards seen</div>
                {[
                  ["mercury","Chemicals / mercury"],
                  ["riverSilt","River siltation"],
                  ["noise","Noise at night"],
                  ["smoke","Burning / smoke"],
                  ["publicRisk","Open pits near public"],
                ].map(([k,label]) => (
                  <label key={k} className="flex items-center gap-2 mb-1">
                    <input type="checkbox" checked={!!form.checklist.hazards[k]} onChange={(e)=>setForm((f: any)=>({ ...f, checklist:{ ...f.checklist, hazards:{ ...f.checklist.hazards, [k]: e.target.checked }}}))} /> {label}
                  </label>
                ))}
              </div>
              <div>
                <div className="font-medium mb-1">When & risk</div>
                <select className="w-full rounded-xl border px-2 py-1 mb-2" value={form.checklist.time} onChange={(e)=>setForm((f: any)=>({ ...f, checklist:{ ...f.checklist, time:e.target.value }}))}>
                  <option value="">Time of day…</option><option>Morning</option><option>Afternoon</option><option>Evening</option><option>Night</option>
                </select>
                <select className="w-full rounded-xl border px-2 py-1" value={form.checklist.risk} onChange={(e)=>setForm((f: any)=>({ ...f, checklist:{ ...f.checklist, risk:e.target.value }}))}>
                  <option value="">Risk level…</option><option>Low</option><option>Medium</option><option>High</option>
                </select>
              </div>
            </div>
          )}
        </div>

        {/* Stealth & Safe Upload */}
        <div className="mt-4 grid sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="block text-sm font-medium">Capture & privacy</label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.stealth} onChange={(e)=>setForm((f: any)=>({ ...f, stealth: e.target.checked }))} /> Stealth mode (no on-screen previews)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.uploadWhenSafe} onChange={(e)=>setForm((f: any)=>({ ...f, uploadWhenSafe: e.target.checked }))} /> Upload when safe (move >= {settings.safe?.minMeters ?? 1000} m or wait {settings.safe?.maxWaitMins ?? 30} mins)
            </label>
            <div className="text-xs text-gray-500">Note: Browsers cannot disable the hardware shutter sound; please silence your device for stealth.</div>
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium">Privacy</label>
            <div className="flex items-center gap-3 text-sm">
              <label className="flex items-center gap-2"><input type="radio" checked={form.anonymous} onChange={() => setForm((f: any) => ({ ...f, anonymous: true }))} /> Anonymous (default)</label>
              <label className="flex items-center gap-2"><input type="radio" checked={!form.anonymous} onChange={() => setForm((f: any) => ({ ...f, anonymous: false }))} /> Share contact (optional follow-up/reward)</label>
            </div>
            {!form.anonymous && (
              <div className="grid sm:grid-cols-2 gap-2">
                <input className="rounded-xl border px-3 py-2" placeholder="Phone" value={form.contact.phone} onChange={(e) => setForm((f: any) => ({ ...f, contact: { ...f.contact, phone: e.target.value } }))} />
                <input className="rounded-xl border px-3 py-2" placeholder="Email" value={form.contact.email} onChange={(e) => setForm((f: any) => ({ ...f, contact: { ...f.contact, email: e.target.value } }))} />
                <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={form.contact.wantsCallback} onChange={(e) => setForm((f: any) => ({ ...f, contact: { ...f.contact, wantsCallback: e.target.checked } }))} /> Request callback</label>
                <input className="rounded-xl border px-3 py-2 sm:col-span-2" placeholder="Preferred time (e.g., 16:00–18:00)" value={form.contact.preferredTime} onChange={(e) => setForm((f: any) => ({ ...f, contact: { ...f.contact, preferredTime: e.target.value } }))} />
                <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={form.rewardOptIn} onChange={(e) => setForm((f: any) => ({ ...f, rewardOptIn: e.target.checked }))} /> Consider me for reward (policy-dependent)</label>
              </div>
            )}
          </div>
        </div>

        {/* Media */}
        <div className="mt-4 grid sm:grid-cols-3 gap-3">
          <div><label className="block text-sm font-medium">Add Photo</label><input type="file" accept="image/*" capture="environment" onChange={(e) => onFileChange(e, "image")} /></div>
          <div><label className="block text-sm font-medium">Add Video</label><input type="file" accept="video/*" capture="environment" onChange={(e) => onFileChange(e, "video")} /></div>
          <div><label className="block text-sm font-medium">Add Voice Note</label><input type="file" accept="audio/*" onChange={(e) => onFileChange(e, "audio")} /></div>
        </div>
        {form.media.length > 0 && !form.stealth && (
          <div className="mt-3 grid sm:grid-cols-3 gap-3">
            {form.media.map((m: Media, idx: number) => (
              <div key={idx} className="border rounded-xl p-2">
                <div className="text-xs text-gray-500 mb-1">{m.type} • {m.name} {m.locked ? "• locked" : ""}</div>
                {m.type === "image" && <img src={m.dataUrl} alt="evidence" className="w-full h-36 object-cover rounded-lg" />}
                {m.type === "video" && <video src={m.dataUrl} className="w-full rounded-lg" controls />}
                {m.type === "audio" && <audio src={m.dataUrl} className="w-full" controls />}
                <div className="mt-2 flex justify-end"><button onClick={() => removeMedia(idx)} className="text-xs text-red-600">Remove</button></div>
              </div>
            ))}
          </div>
        )}
        {form.stealth && form.media.length > 0 && (
          <div className="mt-2 text-xs text-gray-500">Stealth is ON — previews are hidden. Media will queue for safe upload.</div>
        )}

        {/* Blur controls */}
        <div className="mt-4">
          <label className="block text-sm font-medium">Geo-Privacy Blur Radius (meters)</label>
          <input type="range" min={0} max={2000} step={50} value={form.blurRadius} onChange={(e) => setForm((f: any) => ({ ...f, blurRadius: Number(e.target.value) }))} className="w-full" />
          <div className="flex items-center justify-between text-sm text-gray-600">
            <div className="flex gap-2">{[0, 100, 300, 500, 1000, 2000].map((m) => (<button key={m} onClick={() => setForm((f: any) => ({ ...f, blurRadius: m }))} className="px-2 py-1 rounded bg-gray-100">{m}m</button>))}</div>
            <span>Selected: <b>{form.blurRadius} m</b></span>
          </div>
          {form.gps && <div className="mt-3 text-xs text-gray-600">Public map hides the exact point within roughly this radius. Authorities can view raw coordinates.</div>}
        </div>

        <div className="mt-6 flex items-center justify-between">
          <SafetyNotes />
          <div className="flex gap-2">
            <button onClick={submitReport} className="px-4 py-2 rounded-xl bg-emerald-600 text-white">Submit Report</button>
            <button onClick={() => settings.authority?.sms ? alert("Open My Reports → ‘SMS Draft’ to create a message.") : alert("Set an SMS number in Settings first.")} className="px-4 py-2 rounded-xl bg-gray-100">SMS Fallback</button>
          </div>
        </div>
      </Section>

      <Section title="Blur Preview Map (Public vs Private)">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm text-gray-700">Current view: <b>{privateView ? "Private (raw)" : "Public (blurred)"}</b></div>
          <button onClick={() => setPrivateView((v) => !v)} className="px-3 py-1.5 rounded-xl bg-gray-900 text-white">Toggle View</button>
        </div>
        <div className="h-[300px] rounded-xl overflow-hidden border">
          <LeafletPreview gps={form.gps} blurRadius={form.blurRadius} privateView={privateView} />
        </div>
      </Section>
    </div>
  );

  function LeafletPreview({ gps, blurRadius, privateView }: { gps: any; blurRadius: number; privateView: boolean }) {
    const center = gps ? [gps.lat, gps.lon] : [5.556, -0.1969]; // Accra fallback
    const offset = useMemo(() => {
      if (!gps) return null;
      const br = clamp(Number(blurRadius || 0), 0, 2000);
      if (br <= 0) return { lat: gps.lat, lon: gps.lon };
      return randomPointInRing(gps.lat, gps.lon, Math.max(1, br * 0.5), br);
    }, [gps ? gps.lat : null, gps ? gps.lon : null, blurRadius]);

    return (
      <MapContainer center={center as any} zoom={15} style={{ height: "100%", width: "100%" }}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap" />
        {gps && privateView && (<><Marker position={[gps.lat, gps.lon] as any} /><Circle center={[gps.lat, gps.lon] as any} radius={gps.accuracy || 15} /></>)}
        {gps && !privateView && offset && (<><Marker position={[offset.lat, offset.lon] as any} /><Circle center={[gps.lat, gps.lon] as any} radius={clamp(Number(blurRadius || 0), 0, 2000)} /></>)}
      </MapContainer>
    );
  }

  const MyReports = () => (
    <div className="max-w-7xl mx-auto px-3 py-4">
      <Section title="My Reports">
        {reports.length === 0 ? (
          <div className="text-sm text-gray-600">No reports yet. Submit your first report from the New Report tab.</div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
            {reports.map((r) => {
              const safeReady = isSafeToUpload(r, userLoc, Date.now());
              const needsSafe = r.safeUpload?.required && !safeReady;
              return (
                <div key={r.id} className="border rounded-2xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-semibold text-sm">{r.category}</div>
                    <div className="text-xs text-gray-500">{new Date(r.createdAt).toLocaleString()}</div>
                  </div>
                  <div className="text-sm text-gray-700 mb-2 whitespace-pre-line">{r.description}</div>
                  <div className="text-xs text-gray-600 mb-2">{r.gps.lat.toFixed(5)}, {r.gps.lon.toFixed(5)} • ±{Math.round(r.gps.accuracy || 0)} m • Blur {r.blurRadius} m</div>
                  <Timeline status={r.status as string} />
                  {r.media?.length > 0 && (
                    <div className="mt-2 grid grid-cols-3 gap-2">
                      {r.media.slice(0,3).map((m, i) => (
                        <div key={i} className="h-20 overflow-hidden rounded-lg border">
                          {m.type === "image" && <img src={m.dataUrl} className="w-full h-full object-cover" />}
                          {m.type === "video" && <video src={m.dataUrl} className="w-full h-full object-cover" />}
                          {m.type === "audio" && <div className="p-1 text-[10px]">Audio: {m.name}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="mt-2 text-xs">
                    {r.safeUpload?.required && (
                      <div className={needsSafe ? "text-amber-700" : "text-emerald-700"}>
                        Safe upload: <b>{needsSafe ? `Locked (move >= ${settings.safe?.minMeters ?? 1000} m or wait ${settings.safe?.maxWaitMins ?? 30} mins)` : "Ready"}</b>
                      </div>
                    )}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button onClick={() => exportJSON(r)} className="px-3 py-1.5 rounded-xl bg-gray-900 text-white text-xs">Export JSON</button>
                    <button onClick={() => setSelectedReportId(r.id) || setTab("map")} className="px-3 py-1.5 rounded-xl bg-gray-100 text-gray-800 text-xs">Locate on Map</button>
                    {settings.authority?.sms && <button onClick={() => openSMS(r)} className="px-3 py-1.5 rounded-xl bg-gray-100 text-gray-800 text-xs">SMS Draft</button>}
                    {r.status !== "Resolved" && <button onClick={() => setReports((prev) => prev.map((x) => x.id === r.id ? { ...x, status: "In Progress", history: [...x.history, { state: "In Progress", at: new Date().toISOString() }] } : x))} className="px-3 py-1.5 rounded-xl bg-emerald-600 text-white text-xs">Advance Status</button>}
                    <button onClick={() => setReports((prev) => prev.map((x) => x.id === r.id ? { ...x, status: "Resolved", history: [...x.history, { state: "Resolved", at: new Date().toISOString() }] } : x))} className="px-3 py-1.5 rounded-xl bg-blue-600 text-white text-xs">Mark Resolved (demo)</button>
                    <button onClick={() => setReports((prev) => prev.filter((x) => x.id !== r.id))} className="px-3 py-1.5 rounded-xl bg-red-600 text-white text-xs">Delete</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );

  const MapView = () => {
    const [view, setView] = useState(privateView);
    useEffect(() => setView(privateView), [privateView]);
    const selected = reports.find((r) => r.id === selectedReportId) || null;

    const fitPts = useMemo(() => {
      const pts: number[][] = [];
      if (userLoc?.lat && userLoc?.lon) pts.push([userLoc.lat, userLoc.lon]);
      if (selected) {
        const pos = view ? [selected.gps.lat, selected.gps.lon] : [selected.publicOffset.lat, selected.publicOffset.lon];
        pts.push(pos as number[]);
      }
      return pts;
    }, [userLoc?.lat, userLoc?.lon, selected?.id, view]);

    return (
      <div className="max-w-7xl mx-auto px-3 py-4">
        <Section title="Map & Distance Tools">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm text-gray-700">View: <b>{view ? "Private (raw)" : "Public (blurred)"}</b></div>
            <div className="flex gap-2">
              <button onClick={() => setView((v) => !v)} className="px-3 py-1.5 rounded-xl bg-gray-900 text-white">Toggle View</button>
              <button onClick={getUserLoc} className="px-3 py-1.5 rounded-xl bg-gray-100">Locate Me</button>
            </div>
          </div>
          <div className="h-[420px] rounded-xl overflow-hidden border relative">
            <MapContainer center={userLoc ? [userLoc.lat, userLoc.lon] as any : [5.556, -0.1969] as any} zoom={12} style={{ height: "100%", width: "100%" }}>
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap" />
              {userLoc && (<><Marker position={[userLoc.lat, userLoc.lon] as any} /><Circle center={[userLoc.lat, userLoc.lon] as any} radius={userLoc.accuracy || 20} /></>)}
              {reports.map((r) => {
                const pos = view ? [r.gps.lat, r.gps.lon] as any : [r.publicOffset.lat, r.publicOffset.lon] as any;
                const isSel = r.id === selectedReportId;
                return (
                  <React.Fragment key={r.id}>
                    <Marker position={pos} eventHandlers={{ click: () => setSelectedReportId(r.id) }} />
                    {!view && r.blurRadius > 0 && <Circle center={[r.gps.lat, r.gps.lon] as any} radius={r.blurRadius} />}
                    {isSel && fitPts.length > 0 && <FitToBounds points={fitPts} />}
                  </React.Fragment>
                );
              })}
            </MapContainer>
          </div>
          {selected && (
            <div className="mt-3 text-sm text-gray-700">
              Selected: <b>{selected.category}</b> • {new Date(selected.createdAt).toLocaleString()}<br />
              {userLoc && <>Distance from you: <b>{km(haversine(userLoc.lat, userLoc.lon, view ? selected.gps.lat : selected.publicOffset.lat, view ? selected.gps.lon : selected.publicOffset.lon))} km</b></>}
            </div>
          )}
        </Section>
      </div>
    );
  };

  const Help = () => (
    <div className="max-w-7xl mx-auto px-3 py-4">
      <Section title="Safety & Privacy">
        <SafetyNotes />
        <div className="mt-4 text-sm text-gray-700">
          <p className="mb-2"><b>Geo-privacy:</b> Public maps show blurred pins; authorized dashboards (future phase) can access exact coordinates.</p>
          <p className="mb-2"><b>Identity escrow:</b> If you opt for follow-up/reward, your contact is stored locally here; sharing to authorities would require a secure backend (future phase).</p>
          <p className="mb-2"><b>Offline-first:</b> Reports save locally and sync when you tap Sync or regain data.</p>
          <p className="mb-2"><b>Stealth tips:</b> Stealth hides previews and queues upload; it can’t mute the hardware shutter—please silence your phone.</p>
        </div>
      </Section>
    </div>
  );

  const Settings = () => (
    <div className="max-w-3xl mx-auto px-3 py-4">
      <Section title="Authority Contacts (SMS/USSD Fallback)">
        <div className="grid sm:grid-cols-2 gap-3 text-sm">
          <div>
            <label className="block text-sm font-medium">SMS Number</label>
            <input className="mt-1 w-full rounded-xl border px-3 py-2" placeholder="e.g., 190 or +233XXXXXXXXX"
              value={settings.authority?.sms || ""} onChange={(e)=>setSettings((s: any)=>({ ...s, authority:{ ...(s.authority||{}), sms:e.target.value }}))} />
          </div>
          <div>
            <label className="block text-sm font-medium">USSD Code</label>
            <input className="mt-1 w-full rounded-xl border px-3 py-2" placeholder="e.g., *920#"
              value={settings.authority?.ussd || ""} onChange={(e)=>setSettings((s: any)=>({ ...s, authority:{ ...(s.authority||{}), ussd:e.target.value }}))} />
          </div>
        </div>
        <div className="text-xs text-gray-500 mt-2">These are stored only on your device and used to open your SMS app or dialer.</div>
      </Section>
      <Section title="Upload-When-Safe Thresholds">
        <div className="grid sm:grid-cols-2 gap-3 text-sm">
          <div>
            <label className="block text-sm font-medium">Minimum move distance (meters)</label>
            <input type="number" className="mt-1 w-full rounded-xl border px-3 py-2" min={100} step={50}
              value={settings.safe?.minMeters ?? 1000}
              onChange={(e)=>setSettings((s: any)=>({ ...s, safe:{ ...(s.safe||{}), minMeters:Number(e.target.value)||1000 }}))} />
          </div>
          <div>
            <label className="block text-sm font-medium">Max wait time (minutes)</label>
            <input type="number" className="mt-1 w-full rounded-xl border px-3 py-2" min={5} step={5}
              value={settings.safe?.maxWaitMins ?? 30}
              onChange={(e)=>setSettings((s: any)=>({ ...s, safe:{ ...(s.safe||{}), maxWaitMins:Number(e.target.value)||30 }}))} />
          </div>
        </div>
        <div className="text-xs text-gray-500 mt-2">A report unlocks when you move at least this distance away from where it was captured, or after waiting this time.</div>
      </Section>
      <Section title="USSD Quick Dial">
        <button
          onClick={() =>
            settings.authority?.ussd
              ? (window.location.href = `tel:${encodeURIComponent(settings.authority.ussd)}`)
              : alert("Set a USSD code first in Settings.")
          }
          className="px-4 py-2 rounded-xl bg-gray-900 text-white"
        >
          Dial USSD
        </button>
        <div className="text-xs text-gray-500 mt-2">Note: Some devices/browsers restrict USSD links. Copy & dial manually if needed.</div>
      </Section>
    </div>
  );

  // ---- Render ----
  return (
    <div className={`min-h-screen ${form.stealth ? "bg-black" : "bg-gray-50"}`}>
      <Header />
      {tab === "report" && <NewReport />}
      {tab === "my" && <MyReports />}
      {tab === "map" && <MapView />}
      {tab === "help" && <Help />}
      {tab === "settings" && <Settings />}
      <footer className={`max-w-7xl mx-auto px-3 py-6 text-xs ${form.stealth ? "text-gray-400" : "text-gray-500"}`}>
        <div>Demo only • All data stored locally in your browser • Built for AAMUSTED project</div>
      </footer>
      {form.stealth && (
        <div className="fixed inset-0 pointer-events-none flex items-end justify-center pb-8">
          <div className="px-3 py-1.5 rounded-full bg-gray-800/70 text-gray-200 text-xs">Stealth mode is ON</div>
        </div>
      )}
    </div>
  );
}
