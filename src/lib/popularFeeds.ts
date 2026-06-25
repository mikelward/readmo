export interface PopularFeed {
  name: string;
  feedUrl: string;
  category: string;
}

export const POPULAR_FEEDS: PopularFeed[] = [
  // News
  { name: 'AP News', feedUrl: 'https://apnews.com/index.rss', category: 'News' },
  { name: 'BBC News', feedUrl: 'https://feeds.bbci.co.uk/news/rss.xml', category: 'News' },
  { name: 'Reuters', feedUrl: 'https://feeds.reuters.com/reuters/topNews', category: 'News' },
  { name: 'NPR News', feedUrl: 'https://feeds.npr.org/1001/rss.xml', category: 'News' },
  { name: 'CBS News', feedUrl: 'https://www.cbsnews.com/latest/rss/main', category: 'News' },
  { name: 'ABC News', feedUrl: 'https://feeds.abcnews.com/abcnews/topstories', category: 'News' },
  { name: 'NBC News', feedUrl: 'https://feeds.nbcnews.com/nbcnews/public/news', category: 'News' },
  { name: 'PBS NewsHour', feedUrl: 'https://www.pbs.org/newshour/feeds/rss/headlines', category: 'News' },
  { name: 'Al Jazeera', feedUrl: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'News' },
  { name: 'CBC News', feedUrl: 'https://www.cbc.ca/cmlink/rss-topstories', category: 'News' },
  { name: 'Deutsche Welle', feedUrl: 'https://rss.dw.com/rdf/rss-en-all', category: 'News' },
  { name: 'The Guardian', feedUrl: 'https://www.theguardian.com/world/rss', category: 'News' },
  { name: 'New York Times', feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', category: 'News' },
  { name: 'Washington Post', feedUrl: 'https://feeds.washingtonpost.com/rss/world', category: 'News' },
  { name: 'Los Angeles Times', feedUrl: 'https://www.latimes.com/rss2.0.xml', category: 'News' },
  { name: 'Axios', feedUrl: 'https://api.axios.com/feed/', category: 'News' },
  { name: 'Vox', feedUrl: 'https://www.vox.com/rss/index.xml', category: 'News' },
  { name: 'Politico', feedUrl: 'https://www.politico.com/rss/politicopicks.xml', category: 'News' },
  { name: 'The Hill', feedUrl: 'https://thehill.com/news/feed/', category: 'News' },
  { name: 'ProPublica', feedUrl: 'https://feeds.propublica.org/propublica/main', category: 'News' },
  { name: 'NZZ', feedUrl: 'https://www.nzz.ch/recent.rss', category: 'News' },
  { name: 'The Age', feedUrl: 'https://www.theage.com.au/rss/feed.xml', category: 'News' },
  { name: 'Sydney Morning Herald', feedUrl: 'https://www.smh.com.au/rss/feed.xml', category: 'News' },
  { name: 'The Australian', feedUrl: 'https://www.theaustralian.com.au/feed', category: 'News' },
  { name: 'The Globe and Mail', feedUrl: 'https://www.theglobeandmail.com/arc/outboundfeeds/rss/', category: 'News' },
  { name: 'USA Today', feedUrl: 'https://rssfeeds.usatoday.com/usatoday-NewsTopStories', category: 'News' },
  { name: 'HuffPost', feedUrl: 'https://www.huffpost.com/section/front-page/feed', category: 'News' },
  { name: 'Fox News', feedUrl: 'https://moxie.foxnews.com/google-publisher/latest.xml', category: 'News' },
  { name: 'The Boston Globe', feedUrl: 'https://www.bostonglobe.com/rss/bdc/breaking', category: 'News' },

  // Opinion & Analysis
  { name: 'The Atlantic', feedUrl: 'https://www.theatlantic.com/feed/all/', category: 'Opinion & Analysis' },
  { name: 'The Economist', feedUrl: 'https://www.economist.com/latest/rss.xml', category: 'Opinion & Analysis' },
  { name: 'Reason', feedUrl: 'https://reason.com/feed/', category: 'Opinion & Analysis' },
  { name: 'The New Yorker', feedUrl: 'https://www.newyorker.com/feed/everything', category: 'Opinion & Analysis' },
  { name: 'Foreign Affairs', feedUrl: 'https://www.foreignaffairs.com/rss.xml', category: 'Opinion & Analysis' },
  { name: 'Foreign Policy', feedUrl: 'https://foreignpolicy.com/feed/', category: 'Opinion & Analysis' },
  { name: 'Slate', feedUrl: 'https://feeds.slate.com/slate/all-sections', category: 'Opinion & Analysis' },
  { name: 'The Nation', feedUrl: 'https://www.thenation.com/feed/?post_type=article', category: 'Opinion & Analysis' },

  // Technology
  { name: 'Hacker News', feedUrl: 'https://news.ycombinator.com/rss', category: 'Technology' },
  { name: 'Ars Technica', feedUrl: 'https://feeds.arstechnica.com/arstechnica/index', category: 'Technology' },
  { name: 'The Verge', feedUrl: 'https://www.theverge.com/rss/index.xml', category: 'Technology' },
  { name: 'TechCrunch', feedUrl: 'https://techcrunch.com/feed/', category: 'Technology' },
  { name: 'Wired', feedUrl: 'https://www.wired.com/feed/rss', category: 'Technology' },
  { name: 'Engadget', feedUrl: 'https://www.engadget.com/rss.xml', category: 'Technology' },
  { name: 'CNET', feedUrl: 'https://www.cnet.com/rss/news/', category: 'Technology' },
  { name: 'MIT Technology Review', feedUrl: 'https://www.technologyreview.com/feed/', category: 'Technology' },
  { name: '9to5Mac', feedUrl: 'https://9to5mac.com/feed/', category: 'Technology' },
  { name: '9to5Google', feedUrl: 'https://9to5google.com/feed/', category: 'Technology' },
  { name: 'MacRumors', feedUrl: 'https://feeds.macrumors.com/MacRumors', category: 'Technology' },
  { name: 'Slashdot', feedUrl: 'https://rss.slashdot.org/Slashdot/slashdot', category: 'Technology' },
  { name: 'Tom\'s Hardware', feedUrl: 'https://www.tomshardware.com/feeds/all', category: 'Technology' },
  { name: 'AnandTech', feedUrl: 'https://www.anandtech.com/rss/', category: 'Technology' },
  { name: 'GSMArena', feedUrl: 'https://www.gsmarena.com/rss-news-reviews.php3', category: 'Technology' },
  { name: 'Android Authority', feedUrl: 'https://www.androidauthority.com/feed/', category: 'Technology' },
  { name: 'Android Police', feedUrl: 'https://www.androidpolice.com/feed/', category: 'Technology' },
  { name: 'The Register', feedUrl: 'https://www.theregister.com/headlines.atom', category: 'Technology' },
  { name: 'Phoronix', feedUrl: 'https://www.phoronix.com/rss.php', category: 'Technology' },
  { name: 'OSNews', feedUrl: 'https://www.osnews.com/feed/', category: 'Technology' },

  // Programming
  { name: 'GitHub Blog', feedUrl: 'https://github.blog/feed/', category: 'Programming' },
  { name: 'Stack Overflow Blog', feedUrl: 'https://stackoverflow.blog/feed/', category: 'Programming' },
  { name: 'CSS-Tricks', feedUrl: 'https://css-tricks.com/feed/', category: 'Programming' },
  { name: 'Smashing Magazine', feedUrl: 'https://www.smashingmagazine.com/feed/', category: 'Programming' },
  { name: 'A List Apart', feedUrl: 'https://alistapart.com/main/feed/', category: 'Programming' },
  { name: 'Coding Horror', feedUrl: 'https://blog.codinghorror.com/rss/', category: 'Programming' },
  { name: 'Joel on Software', feedUrl: 'https://www.joelonsoftware.com/feed/', category: 'Programming' },
  { name: 'Daring Fireball', feedUrl: 'https://daringfireball.net/feeds/main', category: 'Programming' },
  { name: 'Lobsters', feedUrl: 'https://lobste.rs/rss', category: 'Programming' },
  { name: 'DEV Community', feedUrl: 'https://dev.to/feed', category: 'Programming' },
  { name: 'freeCodeCamp', feedUrl: 'https://www.freecodecamp.org/news/rss/', category: 'Programming' },
  { name: 'Martin Fowler', feedUrl: 'https://martinfowler.com/feed.atom', category: 'Programming' },
  { name: 'Julia Evans', feedUrl: 'https://jvns.ca/atom.xml', category: 'Programming' },
  { name: 'Scott Hanselman', feedUrl: 'https://feeds.hanselman.com/ScottHanselman', category: 'Programming' },
  { name: 'The Old New Thing', feedUrl: 'https://devblogs.microsoft.com/oldnewthing/feed', category: 'Programming' },

  // AI
  { name: 'Anthropic News', feedUrl: 'https://www.anthropic.com/news/rss.xml', category: 'AI' },
  { name: 'OpenAI News', feedUrl: 'https://openai.com/news/rss.xml', category: 'AI' },
  { name: 'Google DeepMind', feedUrl: 'https://deepmind.google/blog/rss.xml', category: 'AI' },

  // Science
  { name: 'NASA Breaking News', feedUrl: 'https://www.nasa.gov/rss/dyn/breaking_news.rss', category: 'Science' },
  { name: 'Science Daily', feedUrl: 'https://www.sciencedaily.com/rss/top/science.xml', category: 'Science' },
  { name: 'New Scientist', feedUrl: 'https://www.newscientist.com/feed/home/', category: 'Science' },
  { name: 'Phys.org', feedUrl: 'https://phys.org/rss-feed/', category: 'Science' },
  { name: 'Scientific American', feedUrl: 'https://www.scientificamerican.com/platform/syndication/rss/', category: 'Science' },
  { name: 'Nature News', feedUrl: 'https://www.nature.com/nature.rss', category: 'Science' },
  { name: 'The Planetary Society', feedUrl: 'https://www.planetary.org/rss/articles', category: 'Science' },
  { name: 'Quanta Magazine', feedUrl: 'https://www.quantamagazine.org/feed/', category: 'Science' },
  { name: 'Space.com', feedUrl: 'https://www.space.com/feeds/all', category: 'Science' },
  { name: 'IEEE Spectrum', feedUrl: 'https://spectrum.ieee.org/feeds/feed.rss', category: 'Science' },
  { name: 'Astronomy Picture of the Day', feedUrl: 'https://apod.nasa.gov/apod.rss', category: 'Science' },

  // Business & Finance
  { name: 'Wall Street Journal', feedUrl: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml', category: 'Business & Finance' },
  { name: 'Bloomberg Markets', feedUrl: 'https://feeds.bloomberg.com/markets/news.rss', category: 'Business & Finance' },
  { name: 'Financial Times', feedUrl: 'https://www.ft.com/rss/home/us', category: 'Business & Finance' },
  { name: 'Forbes', feedUrl: 'https://www.forbes.com/real-time/feed2/', category: 'Business & Finance' },
  { name: 'MarketWatch', feedUrl: 'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines', category: 'Business & Finance' },
  { name: 'Business Insider', feedUrl: 'https://www.businessinsider.com/rss', category: 'Business & Finance' },
  { name: 'Money Saving Expert', feedUrl: 'https://www.moneysavingexpert.com/feed/', category: 'Business & Finance' },

  // Travel
  { name: 'Conde Nast Traveler', feedUrl: 'https://www.cntraveler.com/feed/rss', category: 'Travel' },
  { name: 'The Points Guy', feedUrl: 'https://thepointsguy.com/feed/', category: 'Travel' },
  { name: 'View from the Wing', feedUrl: 'https://viewfromthewing.com/feed/', category: 'Travel' },
  { name: 'One Mile at a Time', feedUrl: 'https://onemileatatime.com/feed/', category: 'Travel' },
  { name: 'Frequent Miler', feedUrl: 'https://frequentmiler.com/feed/', category: 'Travel' },

  // Health
  { name: 'NHS England News', feedUrl: 'https://www.england.nhs.uk/feed/', category: 'Health' },
  { name: 'Quartz', feedUrl: 'https://qz.com/feed', category: 'Business & Finance' },
  { name: 'Inc.', feedUrl: 'https://www.inc.com/rss/', category: 'Business & Finance' },
  { name: 'Fast Company', feedUrl: 'https://www.fastcompany.com/latest/rss', category: 'Business & Finance' },

  // Sports
  { name: 'ESPN', feedUrl: 'https://www.espn.com/espn/rss/news', category: 'Sports' },
  { name: 'BBC Sport', feedUrl: 'https://feeds.bbci.co.uk/sport/rss.xml', category: 'Sports' },
  { name: 'The Athletic', feedUrl: 'https://theathletic.com/rss/', category: 'Sports' },

  // Culture & Entertainment
  { name: 'Pitchfork', feedUrl: 'https://pitchfork.com/rss/news/', category: 'Culture' },
  { name: 'Rolling Stone', feedUrl: 'https://www.rollingstone.com/feed/', category: 'Culture' },
  { name: 'Variety', feedUrl: 'https://variety.com/feed/', category: 'Culture' },
  { name: 'The A.V. Club', feedUrl: 'https://www.avclub.com/rss', category: 'Culture' },
  { name: 'Vulture', feedUrl: 'https://www.vulture.com/rss/all.xml', category: 'Culture' },
  { name: 'Consequence of Sound', feedUrl: 'https://consequenceofsound.net/feed/', category: 'Culture' },

  // YouTube
  // YouTube exposes a public Atom feed per channel at
  // https://www.youtube.com/feeds/videos.xml?channel_id=<UC…>. The IDs below
  // are stable and tied to the channel for life — handles like @MKBHD can
  // change, the UC… ID can't.
  { name: 'MKBHD', feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCBJycsmduvYEL83R_U4JriQ', category: 'YouTube' },
  { name: 'Linus Tech Tips', feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCXuqSBlHAE6Xw-yeJA0Tunw', category: 'YouTube' },
  { name: 'Veritasium', feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCHnyfMqiRRG1u-2MsSQLbXA', category: 'YouTube' },
  { name: 'Kurzgesagt', feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCsXVk37bltHxD1rDPwtNM8Q', category: 'YouTube' },
  { name: '3Blue1Brown', feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCYO_jab_esuFRV4b17AJtAw', category: 'YouTube' },
  { name: 'NASA', feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCLA_DiR1FfKNvjuUpBHmylQ', category: 'YouTube' },
  { name: 'TED Talks', feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCAuUUnT6oDeKwE6v1NGQxug', category: 'YouTube' },

  // Reddit
  { name: 'Reddit Popular', feedUrl: 'https://www.reddit.com/r/popular.rss', category: 'Reddit' },
  { name: 'Reddit World News', feedUrl: 'https://www.reddit.com/r/worldnews.rss', category: 'Reddit' },
  { name: 'Reddit Technology', feedUrl: 'https://www.reddit.com/r/technology.rss', category: 'Reddit' },
  { name: 'Reddit Science', feedUrl: 'https://www.reddit.com/r/science.rss', category: 'Reddit' },
  { name: 'Reddit Programming', feedUrl: 'https://www.reddit.com/r/programming.rss', category: 'Reddit' },
  { name: 'Reddit Today I Learned', feedUrl: 'https://www.reddit.com/r/todayilearned.rss', category: 'Reddit' },

  // Podcasts / Newsletters
  { name: 'Wait But Why', feedUrl: 'https://waitbutwhy.com/feed', category: 'Newsletters' },
  { name: 'Stratechery', feedUrl: 'https://stratechery.com/feed/', category: 'Newsletters' },
  { name: 'Gates Notes', feedUrl: 'https://www.gatesnotes.com/rss', category: 'Newsletters' },

  // Fun
  { name: 'xkcd', feedUrl: 'https://xkcd.com/rss.xml', category: 'Fun' },
  { name: 'The Onion', feedUrl: 'https://www.theonion.com/rss', category: 'Fun' },
  { name: 'Saturday Morning Breakfast Cereal', feedUrl: 'https://www.smbc-comics.com/comic/rss', category: 'Fun' },
];
