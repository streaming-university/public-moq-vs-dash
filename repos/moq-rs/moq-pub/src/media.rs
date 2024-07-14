use crate::cli::Config;
use anyhow::{self, Context};
use moq_transport::cache::{broadcast, fragment, segment, track};
use moq_transport::VarInt;
use mp4::{self, ReadBox, WriteBox};
use serde_json::json;
use std::cmp::max;
use std::collections::HashMap;
use std::io::{BufWriter, Cursor};
use std::time;
use tokio::io::AsyncReadExt;

pub struct Media {
	// We hold on to publisher so we don't close then while media is still being published.
	_broadcast: broadcast::Publisher,
	_catalog: track::Publisher,
	_init: track::Publisher,

	// Tracks based on their track ID.
	tracks: HashMap<u32, Track>,
}

impl Media {
	pub async fn new(_config: &Config, mut broadcast: broadcast::Publisher) -> anyhow::Result<Self> {
		let mut stdin = tokio::io::stdin();

		let ftyp: Vec<u8>;
		loop {
			match read_atom(&mut stdin).await {
				Ok(atom) => {
					ftyp = atom;
					break;
				}
				Err(e) => {
					log::warn!("could not parse ftyp atom: {}", e);
					tokio::time::sleep(time::Duration::from_millis(100)).await;
					continue;
				}
			}
		}

		anyhow::ensure!(&ftyp[4..8] == b"ftyp", "expected ftyp atom");

		let moov = read_atom(&mut stdin).await?;
		anyhow::ensure!(&moov[4..8] == b"moov", "expected moov atom");

		let mut init = ftyp;
		init.extend(&moov);

		// We're going to parse the moov box.
		// We have to read the moov box header to correctly advance the cursor for the mp4 crate.
		let mut moov_reader = Cursor::new(&moov);
		let moov_header = mp4::BoxHeader::read(&mut moov_reader)?;

		// Parse the moov box so we can detect the timescales for each track.
		let moov = mp4::MoovBox::read_box(&mut moov_reader, moov_header.size)?;

		// Create the catalog track with a single segment.
		let mut init_track = broadcast.create_track("0.mp4")?;
		let init_segment = init_track.create_segment(segment::Info {
			sequence: VarInt::ZERO,
			priority: 0,
			expires: None,
		})?;

		// Create a single fragment, optionally setting the size
		let mut init_fragment = init_segment.final_fragment(VarInt::ZERO)?;

		init_fragment.chunk(init.into())?;

		let mut tracks = HashMap::new();

		for trak in &moov.traks {
			let id = trak.tkhd.track_id;
			let name = format!("{}.m4s", id);

			let timescale = track_timescale(&moov, id);

			// Store the track publisher in a map so we can update it later.
			let track = broadcast.create_track(&name)?;
			let track = Track::new(track, timescale);
			tracks.insert(id, track);
		}

		log::debug!("tracks: {:?}", tracks.keys().collect::<Vec<_>>());

		let mut catalog = broadcast.create_track(".catalog")?;

		// Create the catalog track
		Self::serve_catalog(&mut catalog, &init_track.name, &moov, &_config)?;

		Ok(Media {
			_broadcast: broadcast,
			_catalog: catalog,
			_init: init_track,
			tracks,
		})
	}

	pub async fn run(&mut self) -> anyhow::Result<()> {
		let mut stdin = tokio::io::stdin();
		// The current track name
		let mut current = None;

		loop {
			let atom: Vec<u8>;

			loop {
				match read_atom(&mut stdin).await {
					Ok(at) => {
						atom = at;
						break;
					}
					Err(e) => {
						log::warn!("skipping atom: {}", e);
						tokio::time::sleep(time::Duration::from_millis(100)).await;
						continue;
					}
				}
			}

			let mut reader = Cursor::new(&atom);
			let header = mp4::BoxHeader::read(&mut reader)?;

			match header.name {
				mp4::BoxType::MoofBox => {
					let moof = mp4::MoofBox::read_box(&mut reader, header.size).context("failed to read MP4")?;

					// Process the moof.
					let fragment = Fragment::new(moof)?;

					// Get the track for this moof.
					let track = self.tracks.get_mut(&fragment.track).context("failed to find track")?;

					// Save the track ID for the next iteration, which must be a mdat.
					anyhow::ensure!(current.is_none(), "multiple moof atoms");
					current.replace(fragment.track);

					// Publish the moof header, creating a new segment if it's a keyframe.
					track.header(atom, fragment).context("failed to publish moof")?;
				}
				mp4::BoxType::MdatBox => {
					// Get the track ID from the previous moof.
					let track = current.take().context("missing moof")?;
					let track = self.tracks.get_mut(&track).context("failed to find track")?;

					// Publish the mdat atom.
					track.data(atom).context("failed to publish mdat")?;
				}
				mp4::BoxType::PrftBox => {
					let prft = mp4::PrftBox::read_box(&mut reader, header.size).context("failed to read MP4")?;

					// Put this prft to all tracks
					for (track_id, track) in self.tracks.iter_mut() {
						let mut t_prft = prft.clone();
						t_prft.reference_track_id = *track_id;
						track.last_prft = t_prft;
					}
				}

				_ => {
					// Skip unknown atoms
				}
			}
		}
	}

	fn serve_catalog(
		track: &mut track::Publisher,
		init_track_name: &str,
		moov: &mp4::MoovBox,
		config: &Config,
	) -> Result<(), anyhow::Error> {
		let segment = track.create_segment(segment::Info {
			sequence: VarInt::ZERO,
			priority: 0,
			expires: None,
		})?;

		let bitrates = config.bitrates.split(',').collect::<Vec<_>>();

		let mut tracks = Vec::new();
		let mut counter = 0;

		for trak in &moov.traks {
			log::debug!("trak: {:?}", trak);
			let mut track = json!({
				"container": "mp4",
				"init_track": init_track_name,
				"data_track": format!("{}.m4s", trak.tkhd.track_id),
			});

			let stsd = &trak.mdia.minf.stbl.stsd;
			if let Some(avc1) = &stsd.avc1 {
				// avc1[.PPCCLL]
				//
				// let profile = 0x64;
				// let constraints = 0x00;
				// let level = 0x1f;
				let profile = avc1.avcc.avc_profile_indication;
				let constraints = avc1.avcc.profile_compatibility; // Not 100% certain here, but it's 0x00 on my current test video
				let level = avc1.avcc.avc_level_indication;

				let width = avc1.width;
				let height = avc1.height;

				let bitrate = bitrates[counter];

				let codec = rfc6381_codec::Codec::avc1(profile, constraints, level);
				let codec_str = codec.to_string();

				track["kind"] = json!("video");
				track["codec"] = json!(codec_str);
				track["width"] = json!(width);
				track["height"] = json!(height);
				track["bit_rate"] = json!(bitrate.parse::<u32>()?);

				counter += 1;
			} else if let Some(_hev1) = &stsd.hev1 {
				// TODO https://github.com/gpac/mp4box.js/blob/325741b592d910297bf609bc7c400fc76101077b/src/box-codecs.js#L106
				anyhow::bail!("HEVC not yet supported")
			} else if let Some(mp4a) = &stsd.mp4a {
				let desc = &mp4a
					.esds
					.as_ref()
					.context("missing esds box for MP4a")?
					.es_desc
					.dec_config;
				let codec_str = format!("mp4a.{:02x}.{}", desc.object_type_indication, desc.dec_specific.profile);

				track["kind"] = json!("audio");
				track["codec"] = json!(codec_str);
				track["channel_count"] = json!(mp4a.channelcount);
				track["sample_rate"] = json!(mp4a.samplerate.value());
				track["sample_size"] = json!(mp4a.samplesize);

				let bitrate = max(desc.max_bitrate, desc.avg_bitrate);
				if bitrate > 0 {
					track["bit_rate"] = json!(bitrate);
				}
			} else if let Some(vp09) = &stsd.vp09 {
				// https://github.com/gpac/mp4box.js/blob/325741b592d910297bf609bc7c400fc76101077b/src/box-codecs.js#L238
				let vpcc = &vp09.vpcc;
				let codec_str = format!("vp09.0.{:02x}.{:02x}.{:02x}", vpcc.profile, vpcc.level, vpcc.bit_depth);

				track["kind"] = json!("video");
				track["codec"] = json!(codec_str);
				track["width"] = json!(vp09.width); // no idea if this needs to be multiplied
				track["height"] = json!(vp09.height); // no idea if this needs to be multiplied

				// TODO Test if this actually works; I'm just guessing based on mp4box.js
				anyhow::bail!("VP9 not yet supported")
			} else {
				// TODO add av01 support: https://github.com/gpac/mp4box.js/blob/325741b592d910297bf609bc7c400fc76101077b/src/box-codecs.js#L251
				anyhow::bail!("unknown codec for track: {}", trak.tkhd.track_id);
			}

			tracks.push(track);
		}

		let catalog = json!({
			"tracks": tracks
		});

		let catalog_str = serde_json::to_string_pretty(&catalog)?;
		log::info!("catalog: {}", catalog_str);

		// Create a single fragment for the segment.
		let mut fragment = segment.final_fragment(VarInt::ZERO)?;

		// Add the segment and add the fragment.
		fragment.chunk(catalog_str.into())?;

		Ok(())
	}
}

// Read a full MP4 atom into a vector.
async fn read_atom<R: AsyncReadExt + Unpin>(reader: &mut R) -> anyhow::Result<Vec<u8>> {
	// Read the 8 bytes for the size + type
	let mut buf = [0u8; 8];
	if reader.read_exact(&mut buf).await.is_err() {
		return Err(anyhow::anyhow!("failed to read atom header"));
	}

	// Convert the first 4 bytes into the size.
	let size = u32::from_be_bytes(buf[0..4].try_into()?) as u64;

	let mut raw = buf.to_vec();

	let mut limit = match size {
		// Runs until the end of the file.
		0 => reader.take(u64::MAX),

		// The next 8 bytes are the extended size to be used instead.
		1 => {
			reader.read_exact(&mut buf).await?;
			let size_large = u64::from_be_bytes(buf);
			anyhow::ensure!(size_large >= 16, "impossible extended box size: {}", size_large);

			reader.take(size_large - 16)
		}

		2..=7 => {
			anyhow::bail!("impossible box size: {}", size)
		}

		size => reader.take(size - 8),
	};

	// Append to the vector and return it.
	let _read_bytes = limit.read_to_end(&mut raw).await?;

	Ok(raw)
}

struct Track {
	// The track we're producing
	track: track::Publisher,

	// The current segment
	current: Option<fragment::Publisher>,

	// Last PRFT box for this track
	last_prft: mp4::PrftBox,

	// The number of units per second.
	timescale: u64,

	// The number of segments produced.
	sequence: u64,
}

impl Track {
	fn new(track: track::Publisher, timescale: u64) -> Self {
		Self {
			track,
			sequence: 0,
			current: None,
			last_prft: mp4::PrftBox::default(),
			timescale,
		}
	}

	pub fn header(&mut self, raw: Vec<u8>, fragment: Fragment) -> anyhow::Result<()> {
		// Apply the last PRFT box to the raw atom
		let mut prft_buffer = BufWriter::new(Vec::new());
		self.last_prft.write_box(&mut prft_buffer)?;
		let prft = prft_buffer.into_inner()?;

		if let Some(current) = self.current.as_mut() {
			if !fragment.keyframe {
				// Use the existing segment
				current.chunk(prft.into())?;
				current.chunk(raw.into())?;
				return Ok(());
			}
		}

		// Otherwise make a new segment

		// Compute the timestamp in milliseconds.
		// Overflows after 583 million years, so we're fine.
		let timestamp: u32 = fragment
			.timestamp(self.timescale)
			.as_millis()
			.try_into()
			.context("timestamp too large")?;

		// Create a new segment.
		let segment = self.track.create_segment(segment::Info {
			sequence: VarInt::try_from(self.sequence).context("sequence too large")?,

			// Newer segments are higher priority
			priority: u32::MAX.checked_sub(timestamp).context("priority too large")?,
			// priority: self.sequence.try_into().unwrap(),

			// Delete segments after 10s.
			expires: Some(time::Duration::from_secs(10)),
		})?;

		log::info!("serving segment | track:{:?} sequence:{:?} priority:{:?}", self.track.name, segment.sequence, segment.priority);

		// Create a single fragment for the segment that we will keep appending.
		let mut fragment = segment.final_fragment(VarInt::ZERO)?;

		self.sequence += 1;

		// Insert the raw atom into the segment.
		fragment.chunk(prft.into())?;
		fragment.chunk(raw.into())?;

		// Save for the next iteration
		self.current = Some(fragment);

		Ok(())
	}

	pub fn data(&mut self, raw: Vec<u8>) -> anyhow::Result<()> {
		let fragment = self.current.as_mut().context("missing current fragment")?;
		fragment.chunk(raw.into())?;

		Ok(())
	}
}

struct Fragment {
	// The track for this fragment.
	track: u32,

	// The timestamp of the first sample in this fragment, in timescale units.
	timestamp: u64,

	// True if this fragment is a keyframe.
	keyframe: bool,
}

impl Fragment {
	fn new(moof: mp4::MoofBox) -> anyhow::Result<Self> {
		// We can't split the mdat atom, so this is impossible to support
		anyhow::ensure!(moof.trafs.len() == 1, "multiple tracks per moof atom");
		let track = moof.trafs[0].tfhd.track_id;

		// Parse the moof to get some timing information to sleep.
		let timestamp = sample_timestamp(&moof).expect("couldn't find timestamp");

		// Detect if we should start a new segment.
		let keyframe = sample_keyframe(&moof);

		Ok(Self {
			track,
			timestamp,
			keyframe,
		})
	}

	// Convert from timescale units to a duration.
	fn timestamp(&self, timescale: u64) -> time::Duration {
		time::Duration::from_millis(1000 * self.timestamp / timescale)
	}
}

fn sample_timestamp(moof: &mp4::MoofBox) -> Option<u64> {
	Some(moof.trafs.first()?.tfdt.as_ref()?.base_media_decode_time)
}

fn sample_keyframe(moof: &mp4::MoofBox) -> bool {
	for traf in &moof.trafs {
		// TODO trak default flags if this is None
		let default_flags = traf.tfhd.default_sample_flags.unwrap_or_default();
		let trun = match &traf.trun {
			Some(t) => t,
			None => return false,
		};

		for i in 0..trun.sample_count {
			let mut flags = match trun.sample_flags.get(i as usize) {
				Some(f) => *f,
				None => default_flags,
			};

			if i == 0 && trun.first_sample_flags.is_some() {
				flags = trun.first_sample_flags.unwrap();
			}

			// https://chromium.googlesource.com/chromium/src/media/+/master/formats/mp4/track_run_iterator.cc#177
			let keyframe = (flags >> 24) & 0x3 == 0x2; // kSampleDependsOnNoOther
			let non_sync = (flags >> 16) & 0x1 == 0x1; // kSampleIsNonSyncSample

			if keyframe && !non_sync {
				return true;
			}
		}
	}

	false
}

// Find the timescale for the given track.
fn track_timescale(moov: &mp4::MoovBox, track_id: u32) -> u64 {
	let trak = moov
		.traks
		.iter()
		.find(|trak| trak.tkhd.track_id == track_id)
		.expect("failed to find trak");

	trak.mdia.mdhd.timescale as u64
}
