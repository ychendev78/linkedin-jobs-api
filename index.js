const cheerio = require("cheerio");
const axios = require("axios");
const randomUseragent = require("random-useragent");

// Utility functions
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Cache implementation
class JobCache {
  constructor() {
    this.cache = new Map();
    this.TTL = 1000 * 60 * 60; // 1 hour
  }

  set(key, value) {
    this.cache.set(key, {
      data: value,
      timestamp: Date.now(),
    });
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() - item.timestamp > this.TTL) {
      this.cache.delete(key);
      return null;
    }
    return item.data;
  }

  clear() {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > this.TTL) {
        this.cache.delete(key);
      }
    }
  }
}

const cache = new JobCache();

// Generate a unique cache key based on the query parameters
Query.prototype.getCacheKey = function () {
  return `${this.url(0)}_limit:${this.limit}_delayMs:${this.delayMs}`;
};

// Main query function
module.exports.query = (queryObject) => {
  const query = new Query(queryObject);
  return query.getJobs();
};

// Quick helper to just get the count
module.exports.getJobCount = async (queryObject) => {
  const query = new Query(queryObject);
  const jobs = await query.getJobs();
  return jobs.length;
};

// Query constructor
function Query(queryObj) {
  this.host = queryObj.host || "www.linkedin.com";
  this.keyword = queryObj.keyword?.trim().replace(/\s+/g, "+") || "";
  this.location = queryObj.location?.trim().replace(/\s+/g, "+") || "";
  this.dateSincePosted = queryObj.dateSincePosted || "";
  this.jobType = queryObj.jobType || "";
  this.remoteFilter = queryObj.remoteFilter || "";
  this.salary = queryObj.salary || "";
  this.experienceLevel = queryObj.experienceLevel || "";
  this.sortBy = queryObj.sortBy || "";
  // ⬇️ small change: default limit 50 (instead of 0 / unlimited)
  this.limit = Number(queryObj.limit) || 50;
  this.page = Number(queryObj.page) || 0;
  this.has_verification = queryObj.has_verification || false;
  this.under_10_applicants = queryObj.under_10_applicants || false;

  // ⬇️ new: debug logging & configurable delay
  this.debug = Boolean(queryObj.debug) || false;
  this.delayMs = Number(queryObj.delayMs) >= 0 ? Number(queryObj.delayMs) : 2000;
}

// Debug logger
Query.prototype.log = function (...args) {
  if (this.debug) console.log(...args);
};

// Query prototype methods
Query.prototype.getDateSincePosted = function () {
  const dateRange = {
    "past month": "r2592000",
    "past week": "r604800",
    "24hr": "r86400",
  };
  return dateRange[this.dateSincePosted.toLowerCase()] || "";
};

Query.prototype.getExperienceLevel = function () {
  const experienceRange = {
    internship: "1",
    "entry level": "2",
    associate: "3",
    senior: "4",
    director: "5",
    executive: "6",
  };
  return experienceRange[this.experienceLevel.toLowerCase()] || "";
};

Query.prototype.getJobType = function () {
  const jobTypeRange = {
    "full time": "F",
    "full-time": "F",
    "part time": "P",
    "part-time": "P",
    contract: "C",
    temporary: "T",
    volunteer: "V",
    internship: "I",
  };
  return jobTypeRange[this.jobType.toLowerCase()] || "";
};

Query.prototype.getRemoteFilter = function () {
  const remoteFilterRange = {
    "on-site": "1",
    "on site": "1",
    remote: "2",
    hybrid: "3",
  };
  return remoteFilterRange[this.remoteFilter.toLowerCase()] || "";
};

Query.prototype.getSalary = function () {
  const salaryRange = {
    40000: "1",
    60000: "2",
    80000: "3",
    100000: "4",
    120000: "5",
  };
  return salaryRange[this.salary] || "";
};

Query.prototype.getHasVerification = function () {
  return this.has_verification ? "true" : "false";
};

Query.prototype.getUnder10Applicants = function () {
  return this.under_10_applicants ? "true" : "false";
};

Query.prototype.getPage = function () {
  return this.page * 25;
};

Query.prototype.url = function (start) {
  let query = `https://${this.host}/jobs-guest/jobs/api/seeMoreJobPostings/search?`;

  const params = new URLSearchParams();

  if (this.keyword) params.append("keywords", this.keyword);
  if (this.location) params.append("location", this.location);
  if (this.getDateSincePosted())
    params.append("f_TPR", this.getDateSincePosted());
  if (this.getSalary()) params.append("f_SB2", this.getSalary());
  if (this.getExperienceLevel())
    params.append("f_E", this.getExperienceLevel());
  if (this.getRemoteFilter()) params.append("f_WT", this.getRemoteFilter());
  if (this.getJobType()) params.append("f_JT", this.getJobType());
  if (this.getHasVerification())
    params.append("f_VJ", this.getHasVerification());
  if (this.getUnder10Applicants())
    params.append("f_EA", this.getUnder10Applicants());

  params.append("start", start + this.getPage());

  if (this.sortBy === "recent") params.append("sortBy", "DD");
  else if (this.sortBy === "relevant") params.append("sortBy", "R");

  return query + params.toString();
};

Query.prototype.getJobs = async function () {
  let allJobs = [];
  let start = 0;
  const BATCH_SIZE = 25;
  let hasMore = true;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 3;

  this.log("[URL]", this.url());
  this.log("[CacheKey]", this.getCacheKey());

  try {
    // Check cache first
    const cacheKey = this.getCacheKey();
    const cachedJobs = cache.get(cacheKey);
    if (cachedJobs) {
      this.log("Returning cached results");
      return cachedJobs;
    }

    while (hasMore) {
      try {
        const jobs = await this.fetchJobBatch(start);

        if (!jobs || jobs.length === 0) {
          hasMore = false;
          break;
        }

        allJobs.push(...jobs);
        this.log(`Fetched ${jobs.length} jobs. Total: ${allJobs.length}`);

        if (this.limit && allJobs.length >= this.limit) {
          allJobs = allJobs.slice(0, this.limit);
          break;
        }

        // Reset error counter on successful fetch
        consecutiveErrors = 0;
        start += BATCH_SIZE;

        // ⬇️ small change: configurable delay
        await delay(this.delayMs + Math.random() * 500);
      } catch (error) {
        consecutiveErrors++;
        this.log(`Error fetching batch (attempt ${consecutiveErrors}):`, error.message);

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          this.log("Max consecutive errors reached. Stopping.");
          break;
        }

        // Exponential backoff
        await delay(Math.pow(2, consecutiveErrors) * 1000);
      }
    }

    // Cache results if we got any
    if (allJobs.length > 0) {
      cache.set(this.getCacheKey(), allJobs);
    }

    return allJobs;
  } catch (error) {
    console.error("Fatal error in job fetching:", error);
    throw error;
  }
};

Query.prototype.fetchJobBatch = async function (start) {
  const headers = {
    "User-Agent": randomUseragent.getRandom(),
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Referer: "https://www.linkedin.com/jobs",
    "X-Requested-With": "XMLHttpRequest",
    Connection: "keep-alive",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };

  try {
    const response = await axios.get(this.url(start), {
      headers,
      validateStatus: function (status) {
        return status === 200;
      },
      timeout: 10000,
    });

    return parseJobList(response.data, this);
  } catch (error) {
    if (error.response?.status === 429) {
      throw new Error("Rate limit reached");
    }
    throw error;
  }
};

function parseJobList(jobData, queryCtx) {
  try {
    const $ = cheerio.load(jobData);
    const jobs = $("li");

    return jobs
      .map((index, element) => {
        try {
          const job = $(element);
          const position = job.find(".base-search-card__title").text().trim();
          const company = job.find(".base-search-card__subtitle").text().trim();
          const location = job.find(".job-search-card__location").text().trim();
          const dateElement = job.find("time");
          const date = dateElement.attr("datetime");
          const salary = job
            .find(".job-search-card__salary-info")
            .text()
            .trim()
            .replace(/\s+/g, " ");
          const jobUrl = job.find(".base-card__full-link").attr("href");
          const companyLogo =
            job.find(".artdeco-entity-image").attr("data-delayed-url") ||
            // ⬇️ small change: placeholder if missing
            "https://static.licdn.com/sc/h/1bt1uwq5akv756knzdj4l6cdc";
          const agoTime = job.find(".job-search-card__listdate").text().trim();

          // Only return job if we have at least position and company
          if (!position || !company) {
            return null;
          }

          return {
            position,
            company,
            location,
            date,
            salary: salary || "Not specified",
            jobUrl: jobUrl || "",
            companyLogo: companyLogo || "",
            agoTime: agoTime || "",
          };
        } catch (err) {
          queryCtx?.log?.(`Error parsing job at index ${index}:`, err.message);
          return null;
        }
      })
      .get()
      .filter(Boolean);
  } catch (error) {
    console.error("Error parsing job list:", error);
    return [];
  }
}

// Export additional utilities for testing and monitoring
module.exports.JobCache = JobCache;
module.exports.clearCache = () => cache.clear();
module.exports.getCacheSize = () => cache.cache.size;
