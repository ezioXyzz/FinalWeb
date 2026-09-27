import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Bell,
  CheckCircle2,
  Cloud,
  CloudUpload,
  Copy,
  ExternalLink,
  FileImage,
  FileText,
  Folder,
  Grid2X2,
  HardDrive,
  LayoutGrid,
  Link2,
  Loader2,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";

type Section = "Overview" | "My files" | "Shared with me" | "Notes & links" | "Settings";
type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
  sharedWithMeTime?: string;
};
type SharedLinkEntry = {
  id: number;
  title: string;
  url: string;
  category: string;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

const navigation: Array<{ label: Section; icon: typeof LayoutGrid }> = [
  { label: "Overview", icon: LayoutGrid },
  { label: "My files", icon: Folder },
  { label: "Shared with me", icon: Link2 },
  { label: "Notes & links", icon: FileText },
  { label: "Settings", icon: Settings },
];
const MAX_UPLOAD_FILE_BYTES = 20 * 1024 * 1024;

function formatBytes(size?: string) {
  if (!size) return "Google Drive";
  const bytes = Number(size);
  if (!Number.isFinite(bytes)) return "Google Drive";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileGlyph({ type, className = "" }: { type: string; className?: string }) {
  if (type === "application/vnd.google-apps.folder") return <Folder className={className} />;
  if (type.startsWith("image/")) return <FileImage className={className} />;
  return <FileText className={className} />;
}

function FileCard({ file, shared = false, onDownload, downloadPending, isDownloading }: {
  file: DriveFile;
  shared?: boolean;
  onDownload: (file: DriveFile) => void;
  downloadPending: boolean;
  isDownloading: boolean;
}) {
  const owner = file.owners?.[0]?.displayName || file.owners?.[0]?.emailAddress;
  const isFolder = file.mimeType === "application/vnd.google-apps.folder";
  const isOverLimit = Number(file.size) > MAX_UPLOAD_FILE_BYTES;
  return (
    <article className="glass-panel group rounded-[22px] border border-[#e1e5df] bg-white p-4 transition-all hover:-translate-y-1 hover:border-[#c7d3c5] hover:shadow-lg hover:shadow-[#c7d3c5]/20">
      <div className="flex aspect-[1.42] items-center justify-center rounded-[16px] bg-[#f0f2ed] text-[#6d8771]"><FileGlyph type={file.mimeType} className="size-12" /></div>
      <div className="mt-4 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{file.name}</p>
          <p className="mt-1 text-xs text-[#77837c]">{formatBytes(file.size)} · {new Date(file.modifiedTime).toLocaleDateString()}</p>
          {shared && owner && <p className="mt-1 truncate text-xs text-[#829087]">Shared by {owner}</p>}
        </div>
        <span className="mt-0.5 rounded-lg bg-cyan-300/10 p-1.5 text-cyan-200"><ArrowDownToLine className="size-4 shrink-0" /></span>
      </div>
      <Button type="button" variant="outline" onClick={() => onDownload(file)} disabled={isFolder || isOverLimit || downloadPending} className="mt-4 h-10 w-full rounded-xl border-white/15 bg-white/5 text-sm text-slate-200 hover:bg-cyan-300/10 disabled:opacity-50">
        {isDownloading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ArrowDownToLine className="mr-2 size-4" />}
        {isFolder ? "Folder" : isOverLimit ? "Over 20 MB" : isDownloading ? "Downloading…" : "Download"}
      </Button>
    </article>
  );
}

export default function Home() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<Section>("Overview");
  const [searchQuery, setSearchQuery] = useState("");
  const [linkCategoryFilter, setLinkCategoryFilter] = useState("All categories");
  const [linkFormOpen, setLinkFormOpen] = useState(false);
  const [editingLinkId, setEditingLinkId] = useState<number | null>(null);
  const [linkTitle, setLinkTitle] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkCategory, setLinkCategory] = useState("General");
  const [linkNotes, setLinkNotes] = useState("");
  const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null);
  const [cloudflareUploadPending, setCloudflareUploadPending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const handledCallback = useRef(false);
  const trpcUtils = trpc.useUtils();

  const authStatus = trpc.localAuth.status.useQuery();
  const login = trpc.localAuth.login.useMutation({
    onSuccess: async () => {
      setPassword("");
      await authStatus.refetch();
      toast.success("Welcome back to EzioCloud.");
    },
    onError: error => toast.error(error.message),
  });
  const logout = trpc.localAuth.logout.useMutation({
    onSuccess: async () => {
      setActiveSection("Overview");
      setSearchQuery("");
      setLinkCategoryFilter("All categories");
      resetSharedLinkForm();
      await authStatus.refetch();
      toast.success("Signed out successfully.");
    },
  });

  const signedIn = Boolean(authStatus.data?.authenticated);
  const isAdmin = authStatus.data?.user?.role === "admin";
  const currentUserDisplayName = authStatus.data?.user?.displayName || authStatus.data?.user?.username || "EzioCloud";
  const currentUserInitial = currentUserDisplayName.slice(0, 1).toUpperCase() || "E";

  useEffect(() => {
    if (!isAdmin && activeSection === "Settings") {
      setActiveSection("Overview");
      setSearchQuery("");
    }
  }, [isAdmin, activeSection]);

  useEffect(() => {
    if (!isAdmin && linkFormOpen) resetSharedLinkForm();
  }, [isAdmin, linkFormOpen]);

  const driveStatus = trpc.drive.status.useQuery(undefined, { enabled: signedIn });
  const hasDrive = Boolean(driveStatus.data?.connected);
  const driveFiles = trpc.drive.listFiles.useQuery(undefined, {
    enabled: signedIn && hasDrive && activeSection !== "Shared with me" && activeSection !== "Notes & links" && activeSection !== "Settings",
    retry: false,
  });
  const sharedFiles = trpc.drive.listSharedFiles.useQuery(undefined, {
    enabled: signedIn && hasDrive && activeSection === "Shared with me",
    retry: false,
  });
  const sharedLinks = trpc.links.list.useQuery(undefined, {
    enabled: signedIn && activeSection === "Notes & links",
  });
  const createSharedLink = trpc.links.create.useMutation({
    onSuccess: async () => {
      await trpcUtils.links.list.invalidate();
      resetSharedLinkForm();
      toast.success("Link added to the shared notes.");
    },
    onError: error => toast.error(error.message),
  });
  const createSharedLinksBulk = trpc.links.createMany.useMutation({
    onSuccess: async result => {
      await trpcUtils.links.list.invalidate();
      resetSharedLinkForm();
      toast.success(`${result.count} links added to the shared collection.`);
    },
    onError: error => toast.error(error.message),
  });
  const updateSharedLink = trpc.links.update.useMutation({
    onSuccess: async () => {
      await trpcUtils.links.list.invalidate();
      resetSharedLinkForm();
      toast.success("Shared link updated.");
    },
    onError: error => toast.error(error.message),
  });
  const deleteSharedLink = trpc.links.delete.useMutation({
    onSuccess: async () => {
      await trpcUtils.links.list.invalidate();
      toast.success("Shared link removed.");
    },
    onError: error => toast.error(error.message),
  });
  const beginDrive = trpc.drive.getAuthorizationUrl.useMutation({
    onSuccess: result => {
      if (!result.configured || !result.url) {
        toast.message("Google Drive needs its OAuth credentials before it can connect.");
        return;
      }
      window.location.assign(result.url);
    },
    onError: error => toast.error(error.message),
  });
  const completeDrive = trpc.drive.completeConnection.useMutation({
    onSuccess: result => {
      driveStatus.refetch();
      driveFiles.refetch();
      toast.success(`Google Drive connected${result.accountEmail ? ` as ${result.accountEmail}` : ""}.`);
    },
    onError: error => toast.error(error.message),
  });
  const uploadFile = trpc.drive.upload.useMutation({
    onSuccess: file => {
      driveFiles.refetch();
      toast.success(`${file.name} is now in Google Drive.`);
    },
    onError: error => toast.error(error.message),
  });
  const downloadFile = trpc.drive.download.useMutation({
    onSuccess: result => {
      const binary = window.atob(result.contentBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = result.fileName;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setDownloadingFileId(null);
      toast.success(`${result.fileName} downloaded.`);
    },
    onError: error => {
      setDownloadingFileId(null);
      toast.error(error.message);
    },
  });

  useEffect(() => {
    if (handledCallback.current || !signedIn) return;
    const search = new URLSearchParams(window.location.search);
    const code = search.get("code");
    const state = search.get("state");
    const authError = search.get("error");
    if (!code && !authError) return;

    handledCallback.current = true;
    window.history.replaceState({}, document.title, window.location.pathname);
    if (authError) {
      toast.error("Google didn’t finish connecting. Confirm this account is listed as a test user in Google Cloud.");
      return;
    }
    if (code && state) completeDrive.mutate({ code, state });
  }, [signedIn, completeDrive]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      event.preventDefault();
      searchInputRef.current?.focus();
    };

    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    login.mutate({ username, password });
  }

  function handleUploadClick() {
    if (!driveStatus.data?.connected) {
      toast.message(isAdmin ? "Connect Google Drive before uploading." : "Waiting for Imira to connect Google Drive.", {
        description: isAdmin ? "Files are stored directly in the Drive account you authorize." : "Only Imira can change the storage connection.",
      });
      return;
    }
    fileInputRef.current?.click();
  }

  async function handleSelectedFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_UPLOAD_FILE_BYTES) {
      toast.error("EzioCloud supports uploads up to 20 MB per file.");
      return;
    }

    if (import.meta.env.VITE_CLOUDFLARE_DEPLOYMENT === "true") {
      setCloudflareUploadPending(true);
      try {
        const response = await fetch("/api/drive/upload", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-File-Name": encodeURIComponent(file.name),
            "X-File-Type": file.type || "application/octet-stream",
            "X-File-Size": String(file.size),
          },
          body: file,
        });
        const result = await response.json().catch(() => null) as { error?: string; name?: string } | null;
        if (!response.ok) throw new Error(result?.error || `Upload failed (HTTP ${response.status}).`);
        driveFiles.refetch();
        toast.success(`${result?.name || file.name} is now in Google Drive.`);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "The upload failed.");
      } finally {
        setCloudflareUploadPending(false);
      }
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const contentBase64 = dataUrl.split(",")[1];
      if (!contentBase64) {
        toast.error("The file could not be prepared for upload.");
        return;
      }
      uploadFile.mutate({ fileName: file.name, mimeType: file.type || "application/octet-stream", contentBase64 });
    };
    reader.onerror = () => toast.error("The file could not be read.");
    reader.readAsDataURL(file);
  }

  function resetSharedLinkForm() {
    setLinkFormOpen(false);
    setEditingLinkId(null);
    setLinkTitle("");
    setLinkUrl("");
    setLinkCategory("General");
    setLinkNotes("");
  }

  function handleSharedLinkSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const urls = linkUrl.split(/\r?\n/).map(line => line.trim().replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")).filter(Boolean);
    if (urls.length === 0) {
      toast.error("Paste at least one link first.");
      return;
    }
    if (urls.length > 100) {
      toast.error("You can add up to 100 links at once.");
      return;
    }
    if (editingLinkId !== null && urls.length > 1) {
      toast.error("Edit one link at a time.");
      return;
    }
    const category = linkCategory.trim() || "General";
    const notes = linkNotes.trim();
    const entries: Array<{ title: string; url: string; category: string; notes: string }> = [];
    for (const rawUrl of urls) {
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        toast.error("Use complete http:// or https:// links, one per line.");
        return;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        toast.error("Only http:// and https:// links can be saved.");
        return;
      }
      const suggestedTitle = `${parsed.hostname.replace(/^www\./i, "")}${parsed.pathname === "/" ? "" : parsed.pathname}`.slice(0, 160);
      entries.push({
        title: urls.length === 1 && linkTitle.trim() ? linkTitle.trim() : suggestedTitle,
        url: parsed.toString(),
        category,
        notes,
      });
    }
    if (editingLinkId !== null) updateSharedLink.mutate({ id: editingLinkId, ...entries[0]! });
    else if (entries.length === 1) createSharedLink.mutate(entries[0]!);
    else createSharedLinksBulk.mutate({ links: entries });
  }

  function editSharedLink(link: SharedLinkEntry) {
    setEditingLinkId(link.id);
    setLinkTitle(link.title);
    setLinkUrl(link.url);
    setLinkCategory(link.category);
    setLinkNotes(link.notes || "");
    setLinkFormOpen(true);
  }

  function handleDeleteSharedLink(link: SharedLinkEntry) {
    if (!window.confirm(`Remove “${link.title}” from shared links?`)) return;
    deleteSharedLink.mutate({ id: link.id });
  }

  async function copySharedLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied to clipboard.");
    } catch {
      toast.error("Clipboard access is unavailable in this browser.");
    }
  }

  async function downloadCloudflareFile(file: DriveFile) {
    try {
      const response = await fetch(`/api/drive/download?fileId=${encodeURIComponent(file.id)}`, {
        credentials: "same-origin",
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(result?.error || `Download failed (HTTP ${response.status}).`);
      }

      const blob = await response.blob();
      const contentDisposition = response.headers.get("Content-Disposition") || "";
      const encodedName = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      let fileName = file.name;
      if (encodedName) {
        try {
          fileName = decodeURIComponent(encodedName);
        } catch {
          // Keep the Drive name if a browser or proxy returned a malformed header.
        }
      }

      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = fileName;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      toast.success(`${fileName} downloaded.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The download failed.");
    } finally {
      setDownloadingFileId(null);
    }
  }

  function handleDownloadFile(file: DriveFile) {
    if (file.mimeType === "application/vnd.google-apps.folder") return;
    setDownloadingFileId(file.id);
    if (import.meta.env.VITE_CLOUDFLARE_DEPLOYMENT === "true") {
      void downloadCloudflareFile(file);
      return;
    }
    downloadFile.mutate({ fileId: file.id });
  }

  function navigateTo(section: Section) {
    if (section === "Settings" && !isAdmin) {
      toast.error("Only Imira can change EzioCloud settings.");
      return;
    }
    setActiveSection(section);
    setSearchQuery("");
    setMobileOpen(false);
  }

  if (authStatus.isLoading) {
    return (
      <div className="glass-login-scene min-h-screen flex items-center justify-center">
        <div className="glass-panel rounded-2xl px-5 py-4 flex items-center gap-3 text-sm font-medium text-[#46524e]"><Loader2 className="size-4 animate-spin" /> Preparing your workspace</div>
      </div>
    );
  }

  if (!signedIn) {
    return (
      <main className="glass-login-scene login-shell min-h-screen bg-[#f8f7f2] text-[#19251f]">
        <section className="glass-login-hero relative overflow-hidden px-8 py-10 md:px-14 md:py-14 lg:px-20 lg:py-16">
          <div className="login-orbit orbit-one" /><div className="login-orbit orbit-two" />
          <div className="relative z-10 flex h-full flex-col justify-between gap-16">
            <div className="flex items-center gap-3 text-lg font-semibold tracking-[-0.03em]"><span className="glass-mark grid size-10 place-items-center rounded-2xl"><Cloud className="size-5" /></span><span className="tracking-[-0.045em]">Ezio<span className="text-[#7185bc]">Cloud</span></span></div>
            <div className="max-w-lg"><p className="mb-5 inline-flex items-center rounded-full border border-cyan-300/30 bg-cyan-300/10 px-3 py-1.5 text-xs font-semibold tracking-[0.16em] text-cyan-100">Developed by <span className="ml-1 text-fuchsia-300">imira_H</span></p><h1 className="text-5xl font-medium leading-[1.02] tracking-[-0.06em] md:text-6xl">A calmer place for everything you keep.</h1><p className="mt-7 max-w-md text-base leading-7 text-[#68748d]">Your files stay in Google Drive, organized in a simple cloud workspace built around your day.</p></div>
            <div className="flex items-center gap-3 text-sm text-[#707d96]"><ShieldCheck className="size-4 text-[#7185bc]" /> Your account · Your files · Google Drive</div>
          </div>
        </section>
        <section className="flex items-center px-6 py-10 sm:px-12 lg:px-14">
          <div className="glass-login-card mx-auto w-full max-w-md p-7 sm:p-9">
            <div className="mb-9"><p className="text-sm font-semibold text-[#74809a]">Welcome back</p><h2 className="mt-2 text-4xl font-medium tracking-[-0.055em] text-[#25314a]">Sign in to EzioCloud.</h2><p className="mt-3 text-sm leading-6 text-[#69758e]">Use your workspace credentials to continue.</p></div>
            <form onSubmit={handleLogin} className="space-y-5">
              <label className="block space-y-2 text-sm font-semibold text-[#3d4961]">Username<Input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" placeholder="Your username" className="h-12 rounded-xl border-white/80 bg-white/75 px-4 shadow-none focus-visible:ring-[#788bc0]" /></label>
              <label className="block space-y-2 text-sm font-semibold text-[#3d4961]">Password<div className="relative"><Input value={password} onChange={event => setPassword(event.target.value)} type={passwordVisible ? "text" : "password"} autoComplete="current-password" placeholder="Your password" className="h-12 rounded-xl border-white/80 bg-white/75 px-4 pr-12 shadow-none focus-visible:ring-[#788bc0]" /><button type="button" onClick={() => setPasswordVisible(!passwordVisible)} className="absolute inset-y-0 right-0 grid w-12 place-items-center text-xs font-semibold text-[#71809b] hover:text-[#34425f]">{passwordVisible ? "Hide" : "Show"}</button></div></label>
              <Button type="submit" disabled={login.isPending} className="glass-button h-12 w-full rounded-xl text-base font-semibold">{login.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ArrowUpRight className="mr-2 size-4" />}{login.isPending ? "Signing in…" : "Continue"}</Button>
            </form>
          </div>
        </section>
      </main>
    );
  }

  const currentFileQuery = activeSection === "Shared with me" ? sharedFiles : driveFiles;
  const sourceFiles = activeSection === "Shared with me" ? sharedFiles.data || [] : driveFiles.data || [];
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const filteredFiles = sourceFiles.filter(file => file.name.toLocaleLowerCase().includes(normalizedSearch));
  const overviewFiles = filteredFiles.slice(0, 8);
  const visibleFiles = activeSection === "Overview" ? overviewFiles : filteredFiles;
  const allSharedLinks = sharedLinks.data || [];
  const visibleSharedLinks = allSharedLinks.filter(link => {
    const matchesSearch = [link.title, link.url, link.category, link.notes || ""].some(value => value.toLocaleLowerCase().includes(normalizedSearch));
    return matchesSearch && (linkCategoryFilter === "All categories" || link.category === linkCategoryFilter);
  });
  const linkCategories = Array.from(new Set(allSharedLinks.map(link => link.category))).sort((a, b) => a.localeCompare(b));
  const isFileSection = activeSection === "Overview" || activeSection === "My files" || activeSection === "Shared with me";
  const isSearchSection = isFileSection || activeSection === "Notes & links";
  const showUpload = activeSection === "Overview" || activeSection === "My files";
  const pageDate = new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric" }).format(new Date()).toUpperCase();
  const pageHeading: Record<Section, string> = {
    Overview: "Good morning.",
    "My files": "My files",
    "Shared with me": "Shared with me",
    "Notes & links": "Notes & links",
    Settings: "Settings",
  };
  const pageDescription: Record<Section, string> = {
    Overview: "Your connected storage, all in one calm place.",
    "My files": "Files and folders EzioCloud can access in your Google Drive.",
    "Shared with me": "Drive files shared with your Google account.",
    "Notes & links": "A shared, searchable collection for useful links and notes.",
    Settings: "Manage your account and Google Drive connection.",
  };
  const linkFormBusy = createSharedLink.isPending || createSharedLinksBulk.isPending || updateSharedLink.isPending;
  const notesAndLinksView = (
    <section className="mt-7 space-y-5">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#7185bc]">SHARED COLLECTION · {visibleSharedLinks.length} LINKS</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-[-0.045em]">Useful links, in one place</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#78849c]">Every EzioCloud account can browse and open this collection. Only Imira can add, edit, or remove items.</p>
        </div>
        {isAdmin && <Button onClick={() => { resetSharedLinkForm(); setLinkFormOpen(true); }} className="glass-button shrink-0 rounded-xl"><Plus className="mr-2 size-4" /> Add links</Button>}
      </div>

      <div className="flex flex-wrap items-center gap-2" aria-label="Filter links by category">
        <button type="button" onClick={() => setLinkCategoryFilter("All categories")} aria-pressed={linkCategoryFilter === "All categories"} className={`link-category-chip ${linkCategoryFilter === "All categories" ? "is-active" : ""}`}>All categories <span>{allSharedLinks.length}</span></button>
        {linkCategories.map(category => {
          const count = allSharedLinks.filter(link => link.category === category).length;
          return <button key={category} type="button" onClick={() => setLinkCategoryFilter(category)} aria-pressed={linkCategoryFilter === category} className={`link-category-chip ${linkCategoryFilter === category ? "is-active" : ""}`}>{category}<span>{count}</span></button>;
        })}
      </div>

      {isAdmin && linkFormOpen && <form onSubmit={handleSharedLinkSubmit} className="link-editor glass-panel rounded-[24px] p-5 sm:p-6">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div><p className="text-xs font-bold uppercase tracking-[0.13em] text-[#7185bc]">IMIRA · LINK MANAGER</p><h3 className="mt-1 text-xl font-semibold">{editingLinkId === null ? "Add to the collection" : "Edit shared link"}</h3></div>
          <button type="button" onClick={resetSharedLinkForm} aria-label="Close link editor" className="rounded-lg p-2 text-slate-400 hover:bg-white/5 hover:text-white"><X className="size-4" /></button>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-2 text-sm font-semibold text-slate-200">Title <span className="font-normal text-slate-500">(optional when pasting multiple)</span><Input value={linkTitle} onChange={event => setLinkTitle(event.target.value)} maxLength={160} placeholder="e.g. Project dashboard" className="link-input h-11 rounded-xl" /></label>
          <label className="space-y-2 text-sm font-semibold text-slate-200">Category<Input value={linkCategory} onChange={event => setLinkCategory(event.target.value)} maxLength={48} required placeholder="e.g. Work, Tools, Reading" className="link-input h-11 rounded-xl" /></label>
          <label className="space-y-2 text-sm font-semibold text-slate-200 sm:col-span-2">Links <span className="font-normal text-slate-500">· paste one or more, one URL per line</span><textarea value={linkUrl} onChange={event => setLinkUrl(event.target.value)} required rows={4} maxLength={220000} placeholder={'https://example.com\nhttps://another-link.com'} className="link-textarea w-full resize-y rounded-xl px-3 py-3 font-mono text-sm" /></label>
          <label className="space-y-2 text-sm font-semibold text-slate-200 sm:col-span-2">Note <span className="font-normal text-slate-500">(optional; applies to every link in this paste)</span><textarea value={linkNotes} onChange={event => setLinkNotes(event.target.value)} maxLength={4000} rows={2} placeholder="Why this link is useful, or how the team should use it" className="link-textarea w-full resize-y rounded-xl px-3 py-3 text-sm" /></label>
        </div>
        <div className="mt-5 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <p className="text-xs leading-5 text-slate-500">Batch paste accepts up to 100 URLs. Titles are generated from each site when adding a batch.</p>
          <div className="flex gap-2"><Button type="button" variant="outline" onClick={resetSharedLinkForm} className="rounded-xl border-white/15 bg-white/5 text-slate-200">Cancel</Button><Button type="submit" disabled={linkFormBusy} className="glass-button rounded-xl">{linkFormBusy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Plus className="mr-2 size-4" />}{editingLinkId === null ? "Save links" : "Save changes"}</Button></div>
        </div>
      </form>}

      {sharedLinks.isLoading ? <div className="glass-panel grid min-h-44 place-items-center rounded-[24px] text-sm text-slate-400"><span className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Loading shared links…</span></div>
        : sharedLinks.isError ? <div className="glass-panel rounded-[24px] p-8 text-center"><h3 className="font-semibold">We couldn’t load the shared links.</h3><p className="mt-2 text-sm text-slate-400">Check your connection and try again.</p><Button onClick={() => sharedLinks.refetch()} className="glass-button mt-4 rounded-xl">Try again</Button></div>
        : visibleSharedLinks.length === 0 ? <div className="glass-panel rounded-[24px] border border-dashed border-white/15 p-9 text-center"><Link2 className="mx-auto size-8 text-cyan-300" /><h3 className="mt-3 font-semibold">{allSharedLinks.length === 0 ? "Nothing saved here yet" : "No matching links"}</h3><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-400">{allSharedLinks.length === 0 ? isAdmin ? "Add your first link or paste a whole list. Everyone signed in can browse it." : "Shared links added by Imira will appear here." : "Try a different search or category."}</p>{allSharedLinks.length === 0 && isAdmin && <Button onClick={() => { resetSharedLinkForm(); setLinkFormOpen(true); }} className="glass-button mt-5 rounded-xl"><Plus className="mr-2 size-4" /> Add links</Button>}</div>
        : <div className="links-grid grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{visibleSharedLinks.map(link => <article key={link.id} className="link-card glass-panel min-w-0 rounded-[22px] p-5">
          <div className="flex items-center justify-between gap-3"><span className="link-category-label truncate">{link.category}</span><time className="shrink-0 text-[11px] text-slate-500" dateTime={new Date(link.updatedAt).toISOString()}>{new Date(link.updatedAt).toLocaleDateString()}</time></div>
          <h3 className="mt-4 break-words text-lg font-semibold leading-snug">{link.title}</h3>
          {link.notes && <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-slate-400">{link.notes}</p>}
          <a href={link.url} target="_blank" rel="noopener noreferrer" className="link-url mt-4 flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-xs"><span className="truncate">{link.url}</span><ExternalLink className="size-3.5 shrink-0" /></a>
          <div className="mt-4 flex items-center justify-between gap-2 border-t border-white/10 pt-3">
            <span className="text-[11px] text-slate-500">Added by {link.createdBy}</span>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => void copySharedLink(link.url)} aria-label={`Copy ${link.title}`} className="link-icon-button"><Copy className="size-4" /></button>
              {isAdmin && <button type="button" onClick={() => editSharedLink(link)} aria-label={`Edit ${link.title}`} className="link-icon-button"><Pencil className="size-4" /></button>}
              {isAdmin && <button type="button" onClick={() => handleDeleteSharedLink(link)} disabled={deleteSharedLink.isPending} aria-label={`Remove ${link.title}`} className="link-icon-button link-icon-danger"><Trash2 className="size-4" /></button>}
            </div>
          </div>
        </article>)}</div>}
    </section>
  );

  return (
    <main className="glass-dashboard min-h-screen bg-[#f7f7f3] text-[#26324a]">
      <input ref={fileInputRef} onChange={handleSelectedFile} type="file" className="hidden" />
      <aside className={`glass-sidebar fixed inset-y-0 left-0 z-40 flex w-[248px] flex-col border-r border-[#e2e5df] bg-[#fcfcf9] p-4 transition-transform lg:translate-x-0 ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="mb-9 flex items-center justify-between px-2 pt-1">
          <button onClick={() => navigateTo("Overview")} className="flex items-center gap-2.5 text-xl font-semibold tracking-[-0.05em]"><span className="glass-mark grid size-9 place-items-center rounded-2xl"><Cloud className="size-4" /></span><span>Ezio<span className="text-[#7185bc]">Cloud</span></span></button>
          <button onClick={() => setMobileOpen(false)} aria-label="Close navigation" className="rounded-lg p-2 text-[#64716a] hover:bg-[#edf0ea] lg:hidden"><X className="size-4" /></button>
        </div>
        <nav className="space-y-1" aria-label="Main navigation">
          {navigation.filter(item => item.label !== "Settings" || isAdmin).map(item => {
            const Icon = item.icon;
            const selected = activeSection === item.label;
            return <button key={item.label} onClick={() => navigateTo(item.label)} aria-current={selected ? "page" : undefined} className={`flex h-11 w-full items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors ${selected ? "bg-[#7185bc]/12 text-[#52689f]" : "text-[#69758d] hover:bg-white/60 hover:text-[#3f4e6d]"}`}><Icon className="size-4" />{item.label}</button>;
          })}
        </nav>
        <div className="glass-soft-card mt-auto rounded-2xl p-4">
          <div className="mb-2 flex items-center justify-between text-xs font-semibold text-[#52607a]"><span>Storage</span><span>{hasDrive ? "Connected" : "Not connected"}</span></div>
          <Progress value={hasDrive ? 100 : 0} className="neon-progress h-1.5 bg-[#dfe5f2] [&>div]:bg-[#798cc1]" />
          <p className="mt-3 text-xs leading-5 text-[#74819a]">{hasDrive ? (driveStatus.data?.accountEmail || "Google Drive connected") : "Connect Google Drive to start uploading and browsing files."}</p>
        </div>
        <button onClick={() => logout.mutate()} disabled={logout.isPending} className="logout-action mt-4 flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-[#69758d] hover:bg-white/60 hover:text-[#a04d5d]">{logout.isPending ? <Loader2 className="size-4 animate-spin" /> : <LogOut className="size-4" />}{logout.isPending ? "Signing out…" : "Sign out"}</button>
      </aside>
      {mobileOpen && <button onClick={() => setMobileOpen(false)} aria-label="Close navigation overlay" className="fixed inset-0 z-30 bg-[#45577f]/20 backdrop-blur-sm lg:hidden" />}

      <section className="min-h-screen lg:pl-[248px]">
        <header className="glass-topbar flex h-[76px] items-center justify-between border-b border-[#e2e5df] bg-[#fcfcf9]/90 px-5 backdrop-blur md:px-9">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <button onClick={() => setMobileOpen(true)} aria-label="Open navigation" className="rounded-lg p-2 text-[#63718c] hover:bg-white/60 lg:hidden"><Grid2X2 className="size-5" /></button>
            {isSearchSection && <div className="glass-search flex w-full max-w-[560px] flex-1 items-center gap-2 rounded-xl border border-[#e2e5df] bg-white px-3"><Search className="size-4 shrink-0 text-[#8190aa]" /><Input ref={searchInputRef} value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder={activeSection === "Notes & links" ? "Search shared links and notes" : `Search ${activeSection === "Shared with me" ? "shared files" : "files and folders"}`} aria-label={activeSection === "Notes & links" ? "Search links" : "Search files"} className="h-10 min-w-0 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0" />{searchQuery ? <button type="button" onClick={() => setSearchQuery("")} aria-label="Clear search" className="search-clear grid size-7 shrink-0 place-items-center rounded-lg"><X className="size-3.5" /></button> : <kbd className="search-shortcut hidden sm:inline-flex">/</kbd>}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            <button onClick={() => { driveStatus.refetch(); if (activeSection === "Notes & links") sharedLinks.refetch(); else if (activeSection === "Shared with me") sharedFiles.refetch(); else driveFiles.refetch(); }} aria-label="Refresh workspace" className="rounded-xl p-2.5 text-[#687692] hover:bg-white/60"><Bell className="size-4" /></button>
            <div className="hidden text-right sm:block"><p className="text-sm font-semibold">{currentUserDisplayName}</p><p className="text-xs text-[#78849c]">Shared workspace</p></div>
            <span className="glass-avatar grid size-9 place-items-center rounded-2xl text-sm font-bold">{currentUserInitial}</span>
          </div>
        </header>

        <div key={activeSection} className="dashboard-content mx-auto max-w-[1440px] px-5 py-7 md:px-9 md:py-10">
          <div className="mb-7 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
            <div><p className="text-sm font-semibold text-[#7185bc]">{activeSection === "Overview" ? pageDate : "YOUR WORKSPACE"}</p><h1 className="mt-2 text-4xl font-medium tracking-[-0.06em] md:text-5xl">{pageHeading[activeSection]}</h1>{activeSection !== "Overview" && <p className="mt-3 max-w-2xl text-sm leading-6 text-[#78849c]">{pageDescription[activeSection]}</p>}</div>
            {showUpload && <Button onClick={handleUploadClick} disabled={uploadFile.isPending || cloudflareUploadPending} className="glass-button h-11 rounded-xl px-5">{uploadFile.isPending || cloudflareUploadPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Upload className="mr-2 size-4" />} Upload file</Button>}
          </div>

          {activeSection === "Overview" && <section className="grid gap-5 xl:grid-cols-[1.42fr_0.75fr]">
            <div className="space-y-4">
              <div className="home-banner-frame"><img src="/assets/eziocloud-home-user-banner.jpg" alt="Neon EzioCloud gaming-workspace artwork" className="home-banner-image" fetchPriority="high" /></div>
              <div className="glass-panel home-banner-caption flex flex-col justify-between gap-4 rounded-[22px] p-5 sm:flex-row sm:items-center"><div className="min-w-0"><p className="mb-2 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-[#7185bc]"><Sparkles className="size-3.5" /> One place, less noise</p><h2 className="text-xl font-semibold tracking-[-0.04em]">Your files, ready to find.</h2><p className="mt-1 text-sm leading-6 text-[#78849c]">Search your Drive or jump straight into your files.</p></div><Button onClick={() => hasDrive ? navigateTo("My files") : isAdmin ? beginDrive.mutate() : toast.message("Waiting for Imira to connect Google Drive.")} disabled={beginDrive.isPending} className="glass-button shrink-0 rounded-xl">{beginDrive.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}{hasDrive ? "Browse my files" : isAdmin ? "Connect Google Drive" : "Waiting for Imira"}<ArrowUpRight className="ml-2 size-4" /></Button></div>
            </div>
            <div className="glass-panel rounded-[26px] border border-[#e1e5df] bg-white p-6 md:p-7">
              <div className="flex items-start justify-between"><div className="grid size-11 place-items-center rounded-2xl bg-[#edf4ff] text-[#4e78aa]"><HardDrive className="size-5" /></div><span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${hasDrive ? "bg-[#e8f6e9] text-[#4d8054]" : driveStatus.data?.configured ? "bg-[#fff2d9] text-[#a76d16]" : "bg-[#f2efeb] text-[#6f756f]"}`}>{hasDrive ? "CONNECTED" : driveStatus.data?.configured ? "READY TO CONNECT" : "SETUP NEEDED"}</span></div>
              <h2 className="mt-5 text-xl font-semibold tracking-[-0.035em]">Google Drive</h2><p className="mt-2 text-sm leading-6 text-[#77849b]">{hasDrive ? `Connected${driveStatus.data?.accountEmail ? ` to ${driveStatus.data.accountEmail}` : ""}.` : "Use Google Drive as the storage behind EzioCloud."}</p>
              {isAdmin ? <button onClick={() => hasDrive ? navigateTo("Settings") : beginDrive.mutate()} disabled={beginDrive.isPending} className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-[#6278b0] hover:text-[#3f5289]">{beginDrive.isPending ? <Loader2 className="size-4 animate-spin" /> : hasDrive ? <CheckCircle2 className="size-4" /> : <CloudUpload className="size-4" />}{hasDrive ? "Manage connection" : "Connect Google Drive"}</button> : <p className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-[#78849c]"><ShieldCheck className="size-4 text-cyan-300" /> Connection managed by Imira</p>}
            </div>
          </section>}

          {activeSection === "Settings" && isAdmin ? <div className="grid max-w-4xl gap-5 lg:grid-cols-2">
            <section className="glass-panel rounded-[24px] border border-[#e1e5df] bg-white p-6 md:p-7">
              <div className="flex items-center gap-3"><div className="grid size-11 place-items-center rounded-2xl bg-[#edf4ff] text-[#4e78aa]"><HardDrive className="size-5" /></div><div><p className="text-xs font-bold uppercase tracking-[0.12em] text-[#869189]">Storage provider</p><h2 className="mt-0.5 text-xl font-semibold">Google Drive</h2></div></div>
              <div className="my-6 h-px bg-[#edf0ea]" />
              <div className="flex items-center justify-between gap-4"><div><p className="text-sm font-semibold">Connection status</p><p className="mt-1 text-sm text-[#78847d]">{hasDrive ? (driveStatus.data?.accountEmail || "Connected to Google Drive") : "Not connected yet"}</p></div><span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${hasDrive ? "bg-[#e8f6e9] text-[#4d8054]" : "bg-[#f2efeb] text-[#6f756f]"}`}>{hasDrive ? "CONNECTED" : "NOT CONNECTED"}</span></div>
              <p className="mt-5 text-sm leading-6 text-[#78849b]">EzioCloud uses Google’s limited file access permission: it can work with files you create or open with this app, rather than silently scanning your entire Drive.</p>
              <div className="mt-6 flex flex-wrap gap-3"><Button onClick={() => beginDrive.mutate()} disabled={beginDrive.isPending} className="glass-button rounded-xl">{beginDrive.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : hasDrive ? <RefreshCw className="mr-2 size-4" /> : <CloudUpload className="mr-2 size-4" />}{hasDrive ? "Reconnect Google Drive" : "Connect Google Drive"}</Button>{hasDrive && <Button variant="outline" onClick={() => driveFiles.refetch()} disabled={driveFiles.isFetching} className="rounded-xl border-white/80 bg-white/45 text-[#52617e]">{driveFiles.isFetching ? <Loader2 className="mr-2 size-4 animate-spin" /> : <CheckCircle2 className="mr-2 size-4" />}Refresh files</Button>}<a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-2 rounded-xl border border-white/80 bg-white/40 px-4 text-sm font-semibold text-[#52617e] hover:bg-white/70">Manage Google access <ArrowUpRight className="size-4" /></a></div>
            </section>
            <section className="glass-panel rounded-[24px] border border-[#e1e5df] bg-white p-6 md:p-7">
              <div className="flex items-center gap-3"><div className="grid size-11 place-items-center rounded-2xl bg-[#eff4e7] text-[#6f8e58]"><ShieldCheck className="size-5" /></div><div><p className="text-xs font-bold uppercase tracking-[0.12em] text-[#869189]">Account</p><h2 className="mt-0.5 text-xl font-semibold">Your workspace</h2></div></div>
              <div className="my-6 h-px bg-white/70" /><div className="flex items-center justify-between"><div><p className="text-sm font-semibold">Signed in as</p><p className="mt-1 text-sm text-[#78849b]">{authStatus.data?.user?.username || "imira"}</p></div><span className="glass-avatar grid size-10 place-items-center rounded-2xl text-sm font-bold">{currentUserInitial}</span></div>
              <p className="mt-5 text-sm leading-6 text-[#78849b]">All listed logins use this shared EzioCloud workspace and its connected Google Drive.</p>
              <Button variant="outline" onClick={() => logout.mutate()} disabled={logout.isPending} className="mt-6 rounded-xl border-white/80 bg-white/45 text-[#52617e]">{logout.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <LogOut className="mr-2 size-4" />}{logout.isPending ? "Signing out…" : "Sign out"}</Button>
            </section>
          </div> : activeSection === "Notes & links" ? notesAndLinksView : <section className="mt-8">
            <div className="mb-5 flex items-end justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[0.15em] text-[#839087]">{activeSection === "Shared with me" ? "GOOGLE DRIVE SHARES" : hasDrive ? "GOOGLE DRIVE" : "STORAGE"}</p><h2 className="mt-1 text-2xl font-semibold tracking-[-0.045em]">{activeSection === "Overview" ? "Recent files" : activeSection}</h2></div>{hasDrive && <span className="text-sm text-[#7b8780]">{filteredFiles.length} {filteredFiles.length === 1 ? "file" : "files"}</span>}</div>
            {!hasDrive ? <div className="glass-panel rounded-[26px] border border-dashed border-[#cfd8cd] bg-[#fbfcf8] p-9 text-center"><CloudUpload className="mx-auto size-8 text-[#7589bd]" /><h3 className="mt-3 font-semibold">{isAdmin ? "Connect Google Drive to browse real files" : "Waiting for Imira to connect Google Drive"}</h3><p className="mx-auto mt-1 max-w-md text-sm leading-6 text-[#74819a]">{isAdmin ? "After you connect your account, this view will list files EzioCloud can access. Your temporary Drive file access only covers items you create or open with the app." : "Only Imira can change the storage connection. File browsing and transfers will be available once it is connected."}</p>{isAdmin && <Button onClick={() => beginDrive.mutate()} disabled={beginDrive.isPending} className="glass-button mt-5 rounded-xl">{beginDrive.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <CloudUpload className="mr-2 size-4" />} Connect Google Drive</Button>}</div>
            : currentFileQuery.isLoading ? <div className="glass-panel grid min-h-48 place-items-center rounded-[26px] border border-[#e2e5df] bg-white text-sm text-[#738078]"><div className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Loading files from Google Drive…</div></div>
            : currentFileQuery.isError ? <div className="glass-panel rounded-[26px] border border-[#efd9cc] bg-[#fffaf6] p-8 text-center"><h3 className="font-semibold">We couldn’t load this file list.</h3><p className="mt-2 text-sm text-[#806e82]">Google Drive reported: {currentFileQuery.error.message}</p><p className="mt-2 text-sm text-[#6f7b95]">Reconnect the account or check that Google Drive API is enabled and this account has access to the app.</p><Button onClick={() => currentFileQuery.refetch()} className="glass-button mt-4 rounded-xl">Try again</Button></div>
            : visibleFiles.length === 0 ? <div className="glass-panel rounded-[26px] border border-dashed border-[#cfd8cd] bg-[#fbfcf8] p-9 text-center"><Folder className="mx-auto size-8 text-[#8492b1]" /><h3 className="mt-3 font-semibold">{normalizedSearch ? "No matching files" : activeSection === "Shared with me" ? "No shared files found" : "No files available yet"}</h3><p className="mx-auto mt-1 max-w-md text-sm leading-6 text-[#74819a]">{normalizedSearch ? "Try a different search term." : activeSection === "Shared with me" ? "Files shared with you will appear here when they are available to this app." : "Upload a file to your Drive to start building your EzioCloud file list."}</p>{activeSection !== "Shared with me" && !normalizedSearch && <Button onClick={handleUploadClick} className="glass-button mt-5 rounded-xl"><Upload className="mr-2 size-4" /> Upload a file</Button>}</div>
            : <div className="browse-grid grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{visibleFiles.map(file => <FileCard key={file.id} file={file} shared={activeSection === "Shared with me"} onDownload={handleDownloadFile} downloadPending={downloadFile.isPending || Boolean(downloadingFileId)} isDownloading={downloadingFileId === file.id} />)}</div>}
          </section>}
        </div>
      </section>
    </main>
  );
}
