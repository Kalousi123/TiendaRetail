using System.ComponentModel;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Text;
using System.Text.Json;

internal static class Program
{
    public static async Task Main(string[] args)
    {
        using var singleInstance = new Mutex(true, @"Global\TiendaRetailLabelAgent", out var acquired);
        if (!acquired) throw new InvalidOperationException("El agente ya está ejecutándose.");
        if (args.Contains("--console"))
        {
            using var stop = new CancellationTokenSource();
            Console.CancelKeyPress += (_, e) => { e.Cancel = true; stop.Cancel(); };
            await Agent.Run(stop.Token);
        }
        else ServiceBase.Run(new WindowsAgentService());
    }
}
internal sealed class WindowsAgentService : ServiceBase
{
    private CancellationTokenSource? stop;
    private Task? worker;
    public WindowsAgentService() { ServiceName = "TiendaRetailLabels"; CanStop = true; }
    protected override void OnStart(string[] args)
    {
        stop = new();
        worker = Task.Run(() => Agent.Run(stop.Token));
        // A fatal configuration error must stop the service, not leave it appearing healthy.
        _ = worker.ContinueWith(t => { if (t.IsFaulted) { ExitCode = 1; Stop(); } }, TaskScheduler.Default);
    }
    protected override void OnStop() { stop?.Cancel(); try { worker?.Wait(TimeSpan.FromSeconds(10)); } catch { } }
}
internal record Config(string ServerUrl, string AgentToken, string[] AllowedQueues);
internal record PrintJob(string id, string payload, string queue_name, string claim_token);
internal record PollResponse(PrintJob? job);
internal record Receipt(string id, string claim_token, string status, string error, bool acked = false);
internal static class Agent
{
    private static readonly string Root = AppContext.BaseDirectory;
    private static readonly string Journal = Path.Combine(Root, "journal");
    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };
    public static async Task Run(CancellationToken stop)
    {
        var config = JsonSerializer.Deserialize<Config>(await File.ReadAllTextAsync(Path.Combine(Root, "appsettings.json"), stop), Json)
            ?? throw new InvalidOperationException("Configuración ausente");
        var uri = new Uri(config.ServerUrl);
        if (uri.Scheme != "https" || string.IsNullOrWhiteSpace(config.AgentToken) || (config.AllowedQueues is null || config.AllowedQueues.Length < 1))
            throw new InvalidOperationException("Se requiere HTTPS, credencial y al menos una cola autorizada");
        Directory.CreateDirectory(Journal);
        using var client = new HttpClient { BaseAddress = uri, Timeout = TimeSpan.FromSeconds(30) };
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", config.AgentToken);
        while (!stop.IsCancellationRequested)
        {
            try
            {
                // Resolve interrupted sends before claiming more jobs. A durable "sending"
                // marker means bytes may already be at the printer: never send them twice.
                foreach (var file in Directory.EnumerateFiles(Journal, "*.json"))
                {
                    var receipt = JsonSerializer.Deserialize<Receipt>(await File.ReadAllTextAsync(file, stop), Json)!;
                    if (receipt.acked) continue;
                    if (receipt.status == "sending")
                    {
                        receipt = receipt with { status = "uncertain", error = "El agente se interrumpió durante el envío. Verifica las etiquetas antes de reimprimir." };
                        Save(receipt);
                    }
                    await Ack(client, receipt, stop);
                }
                using var response = await client.PostAsJsonAsync("/api/agent/poll", new { }, stop);
                response.EnsureSuccessStatusCode();
                var job = (await response.Content.ReadFromJsonAsync<PollResponse>(cancellationToken: stop))?.job;
                if (job is not null)
                {
                    if (!Guid.TryParse(job.id, out _)) throw new InvalidOperationException("Identificador inválido");
                    var existing = Path.Combine(Journal, job.id + ".json");
                    Receipt receipt;
                    if (File.Exists(existing))
                    {
                        // Never repeat a job, even if the backend unexpectedly claims it again.
                        receipt = JsonSerializer.Deserialize<Receipt>(await File.ReadAllTextAsync(existing, stop), Json)!;
                        receipt = receipt with { claim_token = job.claim_token, status = receipt.status == "sending" ? "uncertain" : receipt.status, acked = false };
                    }
                    else if (!config.AllowedQueues.Contains(job.queue_name, StringComparer.OrdinalIgnoreCase))
                        receipt = new(job.id, job.claim_token, "failed", "La cola no está autorizada en esta PC");
                    else
                    {
                        receipt = new(job.id, job.claim_token, "sending", "");
                        Save(receipt);
                        try { RawPrinter.Send(job.queue_name, Encoding.UTF8.GetBytes(job.payload)); receipt = receipt with { status = "submitted" }; }
                        catch (Exception error) { receipt = receipt with { status = "uncertain", error = error.Message }; }
                    }
                    Save(receipt);
                    await Ack(client, receipt, stop);
                }
                await Task.Delay(TimeSpan.FromSeconds(2), stop);
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { break; }
            catch (Exception error)
            {
                // Tokens and label payloads are intentionally excluded from logs.
                var line = $"{DateTimeOffset.Now:u} {error.Message}{Environment.NewLine}";
                Console.Error.Write(line);
                try {
                    var log = Path.Combine(Root, "agent.log");
                    if (File.Exists(log) && new FileInfo(log).Length > 1_000_000) File.Move(log, log + ".old", true);
                    await File.AppendAllTextAsync(log, line, stop);
                } catch { }
                try { await Task.Delay(TimeSpan.FromSeconds(5), stop); } catch (OperationCanceledException) { break; }
            }
        }
    }
    private static void Save(Receipt receipt)
    {
        var path = Path.Combine(Journal, receipt.id + ".json");
        var temp = path + ".tmp";
        using (var stream = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
        { JsonSerializer.Serialize(stream, receipt); stream.Flush(true); }
        File.Move(temp, path, true);
    }
    private static async Task Ack(HttpClient client, Receipt receipt, CancellationToken stop)
    {
        using var response = await client.PostAsJsonAsync($"/api/agent/jobs/{receipt.id}/ack", new { receipt.claim_token, receipt.status, receipt.error }, stop);
        response.EnsureSuccessStatusCode(); Save(receipt with { acked = true });
    }
}
internal static class RawPrinter
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DocInfo { [MarshalAs(UnmanagedType.LPWStr)] public string Name; [MarshalAs(UnmanagedType.LPWStr)] public string? Output; [MarshalAs(UnmanagedType.LPWStr)] public string Type; }
    [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool OpenPrinter(string name, out IntPtr printer, IntPtr defaults);
    [DllImport("winspool.drv", SetLastError = true)] private static extern bool ClosePrinter(IntPtr printer);
    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)] private static extern int StartDocPrinter(IntPtr printer, int level, ref DocInfo info);
    [DllImport("winspool.drv", SetLastError = true)] private static extern bool EndDocPrinter(IntPtr printer);
    [DllImport("winspool.drv", SetLastError = true)] private static extern bool StartPagePrinter(IntPtr printer);
    [DllImport("winspool.drv", SetLastError = true)] private static extern bool EndPagePrinter(IntPtr printer);
    [DllImport("winspool.drv", SetLastError = true)] private static extern bool WritePrinter(IntPtr printer, byte[] bytes, int length, out int written);
    public static void Send(string name, byte[] data)
    {
        if (!OpenPrinter(name, out var printer, IntPtr.Zero)) throw new Win32Exception();
        try
        {
            var doc = new DocInfo { Name = "Tienda Retail - Etiquetas", Type = "RAW" };
            if (StartDocPrinter(printer, 1, ref doc) == 0) throw new Win32Exception();
            try
            {
                if (!StartPagePrinter(printer)) throw new Win32Exception();
                try { if (!WritePrinter(printer, data, data.Length, out var written) || written != data.Length) throw new Win32Exception("Envío incompleto a la cola de impresión"); }
                finally { if (!EndPagePrinter(printer)) throw new Win32Exception(); }
            }
            finally { if (!EndDocPrinter(printer)) throw new Win32Exception(); }
        }
        finally { ClosePrinter(printer); }
    }
}
