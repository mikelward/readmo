export interface PopularFeed {
  name: string;
  feedUrl: string;
  category: string;
}

export const POPULAR_FEEDS: PopularFeed[] = [
  // News
  { name: 'BBC News', feedUrl: 'https://feeds.bbci.co.uk/news/rss.xml', category: 'News' },
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
  { name: 'The Hill', feedUrl: 'https://thehill.com/news/feed/', category: 'News' },
  { name: 'ProPublica', feedUrl: 'https://feeds.propublica.org/propublica/main', category: 'News' },
  { name: 'NZZ', feedUrl: 'https://www.nzz.ch/recent.rss', category: 'News' },
  { name: 'The Age', feedUrl: 'https://www.theage.com.au/rss/feed.xml', category: 'News' },
  { name: 'Sydney Morning Herald', feedUrl: 'https://www.smh.com.au/rss/feed.xml', category: 'News' },
  // Australia — ABC (public broadcaster), the News Corp metro mastheads, and
  // the Nine/ACM papers. ABC publishes per-section feeds at
  // abc.net.au/news/feed/<id>/rss.xml; "Top Stories" and "Just In" are the two
  // general ones. Sky News Australia exposes no usable native RSS, so it rides
  // a Google News query feed (one reliable host; links resolve via a Google
  // redirect rather than direct to skynews.com.au).
  { name: 'ABC News (Australia)', feedUrl: 'https://www.abc.net.au/news/feed/45910/rss.xml', category: 'News' },
  { name: 'ABC News Just In', feedUrl: 'https://www.abc.net.au/news/feed/51120/rss.xml', category: 'News' },
  { name: 'The Courier-Mail', feedUrl: 'https://www.couriermail.com.au/rss', category: 'News' },
  { name: 'PerthNow', feedUrl: 'https://www.perthnow.com.au/news/feed', category: 'News' },
  { name: 'Brisbane Times', feedUrl: 'https://www.brisbanetimes.com.au/rss/feed.xml', category: 'News' },
  { name: 'WAtoday', feedUrl: 'https://www.watoday.com.au/rss/feed.xml', category: 'News' },
  { name: 'The Canberra Times', feedUrl: 'https://www.canberratimes.com.au/rss.xml', category: 'News' },
  { name: 'SBS News', feedUrl: 'https://www.sbs.com.au/news/feed', category: 'News' },
  { name: 'The Conversation (Australia)', feedUrl: 'https://theconversation.com/au/articles.atom', category: 'News' },
  { name: 'Sky News Australia', feedUrl: 'https://news.google.com/rss/search?q=site:skynews.com.au+when:7d&hl=en-AU&gl=AU&ceid=AU:en', category: 'News' },
  { name: 'The Globe and Mail', feedUrl: 'https://www.theglobeandmail.com/arc/outboundfeeds/rss/', category: 'News' },
  { name: 'HuffPost', feedUrl: 'https://www.huffpost.com/section/front-page/feed', category: 'News' },
  { name: 'Fox News', feedUrl: 'https://moxie.foxnews.com/google-publisher/latest.xml', category: 'News' },

  // International — English-speaking countries + globally significant outlets'
  // English editions. Batch 1 of the planned expansion. These URLs are sourced
  // from published feed lists and each publisher's standard feed conventions
  // but were NOT live-verified at authoring time (the dev sandbox blocks egress
  // to news domains); run `npm run feeds:check` from an unrestricted network to
  // confirm/prune them.
  // United Kingdom
  { name: 'The Telegraph', feedUrl: 'https://www.telegraph.co.uk/news/rss.xml', category: 'News' },
  { name: 'The Independent', feedUrl: 'https://www.independent.co.uk/news/uk/rss', category: 'News' },
  { name: 'Sky News', feedUrl: 'https://feeds.skynews.com/feeds/rss/home.xml', category: 'News' },
  { name: 'Daily Mail', feedUrl: 'https://www.dailymail.co.uk/news/index.rss', category: 'News' },
  { name: 'Daily Mirror', feedUrl: 'https://www.mirror.co.uk/news/?service=rss', category: 'News' },
  { name: 'Metro', feedUrl: 'https://metro.co.uk/feed/', category: 'News' },
  { name: 'Evening Standard', feedUrl: 'https://www.standard.co.uk/news/rss', category: 'News' },
  { name: 'The Spectator', feedUrl: 'https://www.spectator.co.uk/feed', category: 'News' },
  { name: 'New Statesman', feedUrl: 'https://www.newstatesman.com/feed', category: 'News' },
  { name: 'The Conversation (UK)', feedUrl: 'https://theconversation.com/uk/articles.atom', category: 'News' },
  // Ireland
  { name: 'RTÉ News', feedUrl: 'https://www.rte.ie/feeds/rss/?index=/news/', category: 'News' },
  { name: 'The Irish Times', feedUrl: 'https://www.irishtimes.com/arc/outboundfeeds/rss/?outputType=xml', category: 'News' },
  { name: 'Irish Independent', feedUrl: 'https://www.independent.ie/rss', category: 'News' },
  { name: 'TheJournal.ie', feedUrl: 'https://www.thejournal.ie/feed/', category: 'News' },
  { name: 'Irish Examiner', feedUrl: 'https://www.irishexaminer.com/feed/35-top_news.xml', category: 'News' },
  // New Zealand
  { name: 'RNZ', feedUrl: 'https://www.rnz.co.nz/rss/national.xml', category: 'News' },
  { name: 'NZ Herald', feedUrl: 'https://www.nzherald.co.nz/arc/outboundfeeds/rss/', category: 'News' },
  { name: 'Stuff', feedUrl: 'https://www.stuff.co.nz/rss', category: 'News' },
  { name: 'The Spinoff', feedUrl: 'https://thespinoff.co.nz/feed', category: 'News' },
  { name: 'Newsroom', feedUrl: 'https://www.newsroom.co.nz/feed', category: 'News' },
  // India
  { name: 'The Hindu', feedUrl: 'https://www.thehindu.com/news/national/feeder/default.rss', category: 'News' },
  { name: 'Times of India', feedUrl: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms', category: 'News' },
  { name: 'The Indian Express', feedUrl: 'https://indianexpress.com/feed/', category: 'News' },
  { name: 'Hindustan Times', feedUrl: 'https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml', category: 'News' },
  { name: 'NDTV', feedUrl: 'https://feeds.feedburner.com/ndtvnews-top-stories', category: 'News' },
  { name: 'Scroll.in', feedUrl: 'https://scroll.in/feed', category: 'News' },
  { name: 'The Wire', feedUrl: 'https://thewire.in/feed', category: 'News' },
  { name: 'Livemint', feedUrl: 'https://www.livemint.com/rss/newsRSS', category: 'News' },
  // Global English editions
  { name: 'France 24', feedUrl: 'https://www.france24.com/en/rss', category: 'News' },
  { name: 'The Japan Times', feedUrl: 'https://www.japantimes.co.jp/feed/', category: 'News' },
  { name: 'South China Morning Post', feedUrl: 'https://www.scmp.com/rss/91/feed', category: 'News' },
  { name: 'The Straits Times', feedUrl: 'https://www.straitstimes.com/news/singapore/rss.xml', category: 'News' },
  { name: 'The Times of Israel', feedUrl: 'https://www.timesofisrael.com/feed/', category: 'News' },
  { name: 'The Kyiv Independent', feedUrl: 'https://kyivindependent.com/feed/', category: 'News' },
  { name: 'The Moscow Times', feedUrl: 'https://www.themoscowtimes.com/rss/news', category: 'News' },
  { name: 'The National (UAE)', feedUrl: 'https://www.thenationalnews.com/arc/outboundfeeds/rss/', category: 'News' },
  { name: 'Daily Maverick', feedUrl: 'https://www.dailymaverick.co.za/dmrss/', category: 'News' },

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
  { name: 'MarketWatch', feedUrl: 'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines', category: 'Business & Finance' },
  { name: 'Business Insider', feedUrl: 'https://www.businessinsider.com/rss', category: 'Business & Finance' },

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
  { name: 'BBC Sport', feedUrl: 'https://feeds.bbci.co.uk/sport/rss.xml', category: 'Sports' },

  // Culture & Entertainment
  { name: 'Pitchfork', feedUrl: 'https://pitchfork.com/rss/news/', category: 'Culture' },
  { name: 'Rolling Stone', feedUrl: 'https://www.rollingstone.com/feed/', category: 'Culture' },
  { name: 'Variety', feedUrl: 'https://variety.com/feed/', category: 'Culture' },
  { name: 'The A.V. Club', feedUrl: 'https://www.avclub.com/rss', category: 'Culture' },
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

  // Fun
  { name: 'xkcd', feedUrl: 'https://xkcd.com/rss.xml', category: 'Fun' },
  { name: 'The Onion', feedUrl: 'https://www.theonion.com/rss', category: 'Fun' },
  { name: 'Saturday Morning Breakfast Cereal', feedUrl: 'https://www.smbc-comics.com/comic/rss', category: 'Fun' },
];
