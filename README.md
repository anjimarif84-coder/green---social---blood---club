# Green Social Services & Blood Donation Club

বাংলা Modern Premium Green + Red ওয়েবসাইট, Node.js/Express API, SQLite database এবং Admin Panel।

## কী আছে

- Responsive public website (বাংলা)
- Donor registration — নতুন আবেদন `pending` অবস্থায় থাকবে
- Emergency blood request form
- Admin login, dashboard, donor approval/status management, request status management
- Donor phone numbers public website/API-তে প্রকাশ করা হয় না
- Password hashing (bcrypt), session cookie (HttpOnly/SameSite), CSRF token, Helmet security headers, rate limiting
- SQLite database (লোকাল/ছোট ইনস্টলেশনের জন্য)

## দ্রুত শুরু (Admin লগইন)

এই প্যাকেজে `.env` ফাইল ও কোনো ডিফল্ট পাসওয়ার্ড দেওয়া নেই। `.env.example` কপি করে `.env` বানাও, `SESSION_SECRET`-এ লম্বা এলোমেলো মান বসাও, তারপর `npm run create-admin` দিয়ে নিজের অ্যাডমিন তৈরি করো (অন্তত ১২ অক্ষরের পাসওয়ার্ড)। বিস্তারিত নিচে।

- Admin URL: `/admin`
- লগইনের পর সেটিংস থেকে পাসওয়ার্ড বদলানো যায়।
- `.env` কারও সাথে শেয়ার করো না।

## প্রয়োজন

- Node.js 20 বা তার পরের সংস্করণ
- npm

## লোকাল কম্পিউটারে চালানো

1. ZIP extract করো।
2. প্রজেক্ট ফোল্ডারে Terminal/Command Prompt খোলো।
3. Dependency install করো:

   ```bash
   npm install
   ```

4. `.env.example` কপি করে `.env` বানাও। `SESSION_SECRET`-এ অন্তত ৩২ অক্ষরের এলোমেলো গোপন string বসাও। `.env` কখনো কারও সাথে শেয়ার করবে না।

   Linux/macOS:
   ```bash
   cp .env.example .env
   ```

   Windows PowerShell:
   ```powershell
   Copy-Item .env.example .env
   ```

5. প্রথম Admin তৈরি করো:

   ```bash
   npm run create-admin
   ```

   টার্মিনালে username ও অন্তত ১২ অক্ষরের শক্তিশালী password দাও। এটি `.env`-এর কোনো password ব্যবহার করে না।

6. সার্ভার চালাও:

   ```bash
   npm start
   ```

7. ব্রাউজারে খোলো:
   - Public site: http://localhost:3000
   - Admin panel: http://localhost:3000/admin

## Admin কীভাবে ব্যবহার করবে

- Donor Management-এ নতুন আবেদন `অপেক্ষমাণ` হিসেবে দেখা যাবে।
- ফোন/তথ্য যাচাই করে status `অনুমোদিত` করলে public stats-এ শুধু সংখ্যাটি যোগ হবে।
- ফোন নম্বর কেবল Admin Panel-এ দেখা যাবে।
- Blood Requests থেকে আবেদন `যোগাযোগ হয়েছে`, `সম্পন্ন` বা `বাতিল` করা যাবে।

## Database backup

সার্ভার বন্ধ করে `data/club.sqlite` ফাইলটি নিরাপদ স্থানে কপি করো। লাইভ সার্ভারে নিয়মিত encrypted backup রাখবে। ডাটাবেজ বা `.env` কখনো public web folder-এ রেখো না।

## অনলাইনে প্রকাশের আগে অবশ্যই

- HTTPS চালু করো এবং `NODE_ENV=production` সেট করো।
- `.env`-এ শক্তিশালী SESSION_SECRET ব্যবহার করো।
- SQLite database-এর persistent disk/volume নিশ্চিত করো; ephemeral hosting-এ ডেটা হারাতে পারে।
- নিয়মিত backup, update, access control এবং privacy notice যোগ করো।
- Admin account সীমিত ও বিশ্বস্ত ব্যক্তিদের দাও; shared password ব্যবহার করো না।
- সেশন এখন SQLite-এ সংরক্ষিত (রিস্টার্টে লগআউট হয় না)। একাধিক সার্ভার চালালে Redis-ভিত্তিক store ব্যবহার করো।
- সংগঠনের অনুমোদিত privacy policy, data retention period, contact/complaint process এবং donor consent wording ঠিক করো।
- চিকিৎসা-সংক্রান্ত eligibility বা compatibility তথ্য প্রকাশের আগে qualified medical professional/blood bank দিয়ে যাচাই করাও।

## গুরুত্বপূর্ণ সীমাবদ্ধতা

এটি deploy-ready starter project; কোনো hosting account, live domain, email/SMS gateway, OTP, automated donor matching, online payment বা medical verification অন্তর্ভুক্ত নয়। আবেদন জমা হলে Admin Panel-এ দেখা যাবে, কিন্তু স্বয়ংক্রিয় SMS/WhatsApp পাঠানো হয় না। SQLite ছোট ও মাঝারি প্রাথমিক ব্যবহারের জন্য; বহু সার্ভার/বড় ট্রাফিকের ক্ষেত্রে PostgreSQL এবং managed session store-এ migrate করা উচিত।
