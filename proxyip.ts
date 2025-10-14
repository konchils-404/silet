import tls from "tls";

interface ProxyStruct {
  address: string;
  port: number;
  country: string;
  org: string;
}

interface ProxyTestResult {
  error: boolean;
  message?: string;
  result?: {
    proxy: string;
    proxyip: boolean;
    ip: string;
    port: number;
    delay: number;
    country: string;
    asOrganization: string;
  };
}

let myGeoIpString: any = null;

const KV_PAIR_PROXY_FILE = "./data/KvProxy.json";
const RAW_PROXY_LIST_FILE = "./data/RawProxy.txt";
const PROXY_LIST_FILE = "./data/proxy.txt";
const IP_RESOLVER_DOMAIN = "myip.ipeek.workers.dev";
const IP_RESOLVER_PATH = "/";
const CONCURRENCY = 50; // Reduced for stability

async function sendRequest(host: string, path: string, proxy: any = null) {
  return new Promise((resolve, reject) => {
    const options = {
      host: proxy ? proxy.host : host,
      port: proxy ? proxy.port : 443,
      servername: host,
    };

    const socket = tls.connect(options, () => {
      const request =
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${host}\r\n` +
        `User-Agent: Mozilla/5.0\r\n` +
        `Connection: close\r\n\r\n`;
      socket.write(request);
    });

    let responseBody = "";

    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("socket timeout"));
    }, 10000); // Increased timeout

    socket.on("data", (data) => (responseBody += data.toString()));
    socket.on("end", () => {
      clearTimeout(timeout);
      const body = responseBody.split("\r\n\r\n")[1] || "";
      resolve(body);
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function checkProxy(proxyAddress: string, proxyPort: number): Promise<ProxyTestResult> {
  let result: ProxyTestResult = {
    message: "Unknown error",
    error: true,
  };

  const proxyInfo = { host: proxyAddress, port: proxyPort };

  try {
    const start = Date.now();
    const [ipinfo, myip] = await Promise.all([
      sendRequest(IP_RESOLVER_DOMAIN, IP_RESOLVER_PATH, proxyInfo),
      myGeoIpString == null ? sendRequest(IP_RESOLVER_DOMAIN, IP_RESOLVER_PATH, null) : myGeoIpString,
    ]);
    const finish = Date.now();

    // Save local geoip
    if (myGeoIpString == null) myGeoIpString = myip;

    const parsedIpInfo = JSON.parse(ipinfo as string);
    const parsedMyIp = JSON.parse(myip as string);

    if (parsedIpInfo.ip && parsedIpInfo.ip !== parsedMyIp.ip) {
      result = {
        error: false,
        result: {
          proxy: proxyAddress,
          proxyip: true,
          ip: parsedIpInfo.ip,
          port: proxyPort,
          delay: finish - start,
          country: parsedIpInfo.country || "Unknown",
          asOrganization: parsedIpInfo.org || parsedIpInfo.asOrganization || "Unknown",
        },
      };
    } else {
      result.message = "IP tidak berbeda (bukan proxy)";
    }
  } catch (error: any) {
    result.message = error.message;
  }

  return result;
}

async function readProxyList(): Promise<ProxyStruct[]> {
  const proxyList: ProxyStruct[] = [];

  try {
    const file = Bun.file(RAW_PROXY_LIST_FILE);
    if (!(await file.exists())) {
      console.error(`❌ File ${RAW_PROXY_LIST_FILE} tidak ditemukan!`);
      return proxyList;
    }

    const content = await file.text();
    if (!content.trim()) {
      console.error(`❌ File ${RAW_PROXY_LIST_FILE} kosong!`);
      return proxyList;
    }

    const proxyListString = content.trim().split("\n");
    console.log(`📄 Baris di RawProxy.txt: ${proxyListString.length}`);

    for (const proxy of proxyListString) {
      try {
        const [address, port, country, org] = proxy.split(",");
        if (address && port) {
          proxyList.push({
            address: address.trim(),
            port: parseInt(port.trim()),
            country: (country?.trim() || "Unknown").replace(/[^a-zA-Z]/g, ""),
            org: (org?.trim() || "Unknown").replaceAll(/[+]/g, " "),
          });
        }
      } catch (e) {
        // Skip invalid lines
        continue;
      }
    }

    console.log(`🔢 Proxy valid: ${proxyList.length}`);
  } catch (error) {
    console.error("Error reading proxy list:", error);
  }

  return proxyList;
}

async function processProxies(proxyList: ProxyStruct[]) {
  const uniqueRawProxies: string[] = [];
  const activeProxyList: string[] = [];
  const kvPair: any = {};
  const proxyChecked = new Set<string>();

  let successfulChecks = 0;
  let failedChecks = 0;

  // Process proxies in batches
  const batchSize = CONCURRENCY;
  
  for (let i = 0; i < proxyList.length; i += batchSize) {
    const batch = proxyList.slice(i, i + batchSize);
    console.log(`\n🔄 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(proxyList.length / batchSize)}`);
    
    const promises = batch.map(async (proxy, index) => {
      const proxyKey = `${proxy.address}:${proxy.port}`;
      const globalIndex = i + index;
      
      // Skip duplicates
      if (proxyChecked.has(proxyKey)) {
        return null;
      }
      proxyChecked.add(proxyKey);

      try {
        // Add to raw list (format sesuai kebutuhan)
        uniqueRawProxies.push(`${proxy.address},${proxy.port},${proxy.country},${proxy.org}`);
        
        // Check proxy
        const res = await checkProxy(proxy.address, proxy.port);
        
        if (!res.error && res.result?.proxyip === true) {
          const result = res.result;
          const proxyString = `${result.proxy},${result.port},${result.country},${result.asOrganization}`;
          activeProxyList.push(proxyString);

          // Update KV pairs
          const country = result.country;
          if (!kvPair[country]) {
            kvPair[country] = [];
          }
          if (kvPair[country].length < 10) {
            kvPair[country].push(`${result.proxy}:${result.port}`);
          }
          
          successfulChecks++;
          console.log(`[${globalIndex + 1}/${proxyList.length}] ✅ ${proxyKey} (${result.delay}ms) - ${country}`);
          return true;
        } else {
          failedChecks++;
          console.log(`[${globalIndex + 1}/${proxyList.length}] ❌ ${proxyKey} - ${res.message}`);
          return false;
        }
      } catch (error: any) {
        failedChecks++;
        console.log(`[${globalIndex + 1}/${proxyList.length}] 💥 ${proxyKey} - ${error.message}`);
        return false;
      }
    });

    await Promise.all(promises);
    
    // Progress update
    const progress = ((i + batchSize) / proxyList.length * 100).toFixed(1);
    console.log(`📊 Progress: ${progress}% | ✅ Success: ${successfulChecks} | ❌ Failed: ${failedChecks}`);
    
    // Delay between batches
    if (i + batchSize < proxyList.length) {
      console.log(`⏳ Waiting 2 seconds before next batch...`);
      await Bun.sleep(2000);
    }
  }

  console.log(`\n🎯 FINAL RESULTS:`);
  console.log(`✅ Successful: ${successfulChecks}`);
  console.log(`❌ Failed: ${failedChecks}`);
  console.log(`📝 Unique proxies: ${uniqueRawProxies.length}`);
  console.log(`🔥 Active proxies: ${activeProxyList.length}`);
  console.log(`🌍 Countries: ${Object.keys(kvPair).length}`);

  return { uniqueRawProxies, activeProxyList, kvPair };
}

(async () => {
  try {
    console.log("🚀 Starting proxy scanner...");
    
    // Ensure data directory exists
    try {
      await Bun.$`mkdir -p ./data`.quiet();
    } catch (e) {
      // Directory might already exist
    }

    const proxyList = await readProxyList();
    
    if (proxyList.length === 0) {
      console.error("❌ No proxies to check! Exiting...");
      process.exit(1);
    }

    console.log(`\n📋 Loaded ${proxyList.length} proxies for checking`);
    
    const { uniqueRawProxies, activeProxyList, kvPair } = await processProxies(proxyList);

    // Sort results
    uniqueRawProxies.sort(sortByCountry);
    activeProxyList.sort(sortByCountry);

    // Sort KV pairs by country name
    const sortedKvPair: any = {};
    Object.keys(kvPair).sort().forEach(key => {
      sortedKvPair[key] = kvPair[key];
    });

    // Write files
    console.log(`\n💾 Saving files...`);
    
    await Bun.write(KV_PAIR_PROXY_FILE, JSON.stringify(sortedKvPair, null, 2));
    console.log(`✅ Saved: ${KV_PAIR_PROXY_FILE} (${Object.keys(sortedKvPair).length} countries)`);

    await Bun.write(RAW_PROXY_LIST_FILE, uniqueRawProxies.join("\n"));
    console.log(`✅ Saved: ${RAW_PROXY_LIST_FILE} (${uniqueRawProxies.length} proxies)`);

    // Add header to proxy.txt
    const timestamp = new Date().toISOString();
    const proxyContent = `# Proxy List\n# Generated: ${timestamp}\n# Total Active: ${activeProxyList.length}\n# Countries: ${Object.keys(sortedKvPair).length}\n\n${activeProxyList.join("\n")}`;
    await Bun.write(PROXY_LIST_FILE, proxyContent);
    console.log(`✅ Saved: ${PROXY_LIST_FILE} (${activeProxyList.length} active proxies)`);

    // Show sample output
    if (activeProxyList.length > 0) {
      console.log(`\n📋 Sample active proxies (first 5):`);
      activeProxyList.slice(0, 5).forEach(proxy => console.log(`  ${proxy}`));
    }

    if (Object.keys(sortedKvPair).length > 0) {
      console.log(`\n🌍 Countries found:`);
      Object.keys(sortedKvPair).slice(0, 10).forEach(country => {
        console.log(`  ${country}: ${sortedKvPair[country].length} proxies`);
      });
      if (Object.keys(sortedKvPair).length > 10) {
        console.log(`  ... and ${Object.keys(sortedKvPair).length - 10} more countries`);
      }
    }

    console.log(`\n🎉 Scan completed successfully!`);
    console.log(`⏱️  Total time: ${(Bun.nanoseconds() / 1000000000).toFixed(2)} seconds`);

  } catch (error) {
    console.error("💥 Critical error:", error);
    process.exit(1);
  }
  
  process.exit(0);
})();

function sortByCountry(a: string, b: string) {
  const countryA = a.split(",")[2] || "Unknown";
  const countryB = b.split(",")[2] || "Unknown";
  return countryA.localeCompare(countryB);
}
