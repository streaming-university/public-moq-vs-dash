use std::{
	collections::{hash_map, HashMap}, result, sync::{Arc, Mutex}, thread::JoinHandle, u32
};

use tokio::task::AbortHandle;
use webtransport_quinn::Session;

use crate::{
	cache::{broadcast, segment, track, CacheError},
	message,
	message::Message,
	MoqError, VarInt,
};

use super::{Control, SessionError};


/// Serves broadcasts over the network, automatically handling subscriptions and caching.
// TODO Clone specific fields when a task actually needs it.
#[derive(Clone, Debug)]
pub struct Publisher {
	// A map of active subscriptions, containing an abort handle to cancel them.
	subscribes: Arc<Mutex<HashMap<VarInt, AbortHandle>>>,
	webtransport: Session,
	control: Control,
	source: broadcast::Subscriber,
}

impl Publisher {
	pub(crate) fn new(webtransport: Session, control: Control, source: broadcast::Subscriber) -> Self {
		Self {
			webtransport,
			control,
			subscribes: Default::default(),
			source,
		}
	}

	// TODO Serve a broadcast without sending an ANNOUNCE.
	// fn serve(&mut self, broadcast: broadcast::Subscriber) -> Result<(), SessionError> {

	// TODO Wait until the next subscribe that doesn't route to an ANNOUNCE.
	// pub async fn subscribed(&mut self) -> Result<track::Producer, SessionError> {

	pub async fn run(mut self) -> Result<(), SessionError> {
		let res = self.run_inner().await;

		// Terminate all active subscribes on error.
		self.subscribes
			.lock()
			.unwrap()
			.drain()
			.for_each(|(_, abort)| abort.abort());

		res
	}

	pub async fn run_inner(&mut self) -> Result<(), SessionError> {
		log::debug!("running publisher");
		loop {
			tokio::select! {
				stream = self.webtransport.accept_uni() => {
					stream?;
					return Err(SessionError::RoleViolation(VarInt::ZERO));
				},
				// NOTE: this is not cancel safe, but it's fine since the other branchs are fatal.
				msg = self.control.recv() => {
					let msg = msg?;

					log::info!("message received: {:?}", msg);
					if let Err(err) = self.recv_message(&msg).await {
						log::warn!("message error: {:?} {:?}", err, msg);
					}
				},
				// No more broadcasts are available.
				err = self.source.closed() => {
					self.webtransport.close(err.code(), err.reason().as_bytes());
					return Ok(());
				},
			}
		}
	}

	/* TODO: Uncomment here when it's implemented in webtransport-quinn
	pub fn get_throughput(&self) -> u64 {
		// self.webtransport.throughput()
		0
	}
	*/

	async fn recv_message(&mut self, msg: &Message) -> Result<(), SessionError> {
		log::info!("received message: {:?}", msg);
		match msg {
			Message::AnnounceOk(msg) => self.recv_announce_ok(msg).await,
			Message::AnnounceError(msg) => self.recv_announce_error(msg).await,
			Message::Subscribe(msg) => self.recv_subscribe(msg).await,
			Message::Unsubscribe(msg) => self.recv_unsubscribe(msg).await,
			_ => Err(SessionError::RoleViolation(msg.id())),
		}
	}

	async fn recv_announce_ok(&mut self, _msg: &message::AnnounceOk) -> Result<(), SessionError> {
		// We didn't send an announce.
		Err(CacheError::NotFound.into())
	}

	async fn recv_announce_error(&mut self, _msg: &message::AnnounceError) -> Result<(), SessionError> {
		// We didn't send an announce.
		Err(CacheError::NotFound.into())
	}

	async fn recv_subscribe(&mut self, msg: &message::Subscribe) -> Result<(), SessionError> {
		log::info!("received subscribe: {:?}", msg);
		// Assume that the subscribe ID is unique for now.
		if msg.name.starts_with(".probe") {
			let mut probe_size = 20000;
			let mut probe_priority = 0;
			if msg.name.starts_with(".probe:") {
				let parameters = msg.name.split(":").collect::<Vec<&str>>();
				probe_size = parameters.get(1).unwrap().parse().unwrap();
				probe_priority = parameters.get(2).unwrap().parse().unwrap();
			}
			let mut this = self.clone();
			let probe_msg = msg.clone();
			tokio::spawn(async move {
				let res = this.send_probe_data(probe_msg.id, probe_size, probe_priority).await;
				if let Err(err) = &res {
					log::warn!("failed to send probe data: {:?}", err);
				}
			});
		} else {
			let abort = match self.start_subscribe(msg.clone()) {
				Ok(abort) => abort,
				Err(err) => return self.reset_subscribe(msg.id, err).await,
			};

			// log
			log::info!("subscribe started: {:?}", msg);

			// Insert the abort handle into the lookup table.
			match self.subscribes.lock().unwrap().entry(msg.id) {
				hash_map::Entry::Occupied(_) => return Err(CacheError::Duplicate.into()), // TODO fatal, because we already started the task
				hash_map::Entry::Vacant(entry) => entry.insert(abort),
			};
		}

		self.control
			.send(message::SubscribeOk {
				id: msg.id,
				expires: VarInt::ZERO,
			})
			.await
	}

	async fn reset_subscribe<E: MoqError>(&mut self, id: VarInt, err: E) -> Result<(), SessionError> {
		let msg = message::SubscribeReset {
			id,
			code: err.code(),
			reason: err.reason(),

			// TODO properly populate these
			// But first: https://github.com/moq-wg/moq-transport/issues/313
			final_group: VarInt::ZERO,
			final_object: VarInt::ZERO,
		};

		self.control.send(msg).await
	}

	async fn send_probe_data(&mut self, id: VarInt, probe_size: u32, probe_priority: u32) -> Result<(), SessionError>{
		log::info!("sending probe data");

		let stream_priority: i32 = match probe_priority {
			1 => i32::MAX,
			_ => 0,
		};

		let mut stream = self.webtransport.open_uni().await?;
		// Convert the u32 to a i32, since the Quinn set_priority is signed.
		stream.set_priority(stream_priority).ok();

		let ntp_timestamp = match VarInt::try_from(chrono::Utc::now().timestamp_millis() as u64) {
			Ok(ntp_timestamp) => ntp_timestamp,
			Err(e) => return Err(SessionError::BoundsExceeded(e)),
		};

		let payload = vec![0_u8; probe_size.try_into().unwrap()];

		// write the object


		let object = message::Object {
			track: id,
			group: VarInt::from_u32(0),
			priority: probe_priority,
			sequence: VarInt::from_u32(0),
			expires: None,
			ntp_timestamp: Option::from(ntp_timestamp),
			size: Some(VarInt::try_from(probe_size).unwrap())
		};

		object
			.encode(&mut stream, &self.control.ext)
			.await
			.map_err(|e| SessionError::Unknown(e.to_string()))?;

		// write the payload
		let result = stream.write_all(&payload).await;
		if let Err(err) = result {
			log::warn!("failed to write probe data: {:?}", err);
		}
		log::info!("sent probe data");
		Ok(())
	}

	fn start_subscribe(&mut self, msg: message::Subscribe) -> Result<AbortHandle, SessionError> {
		// We currently don't use the namespace field in SUBSCRIBE
		// Make sure the namespace is empty if it's provided.
		if msg.namespace.as_ref().map_or(false, |namespace| !namespace.is_empty()) {
			return Err(CacheError::NotFound.into());
		}

		// TODO only clone the fields we need
		let mut this = self.clone();

		let mut track = self.source.get_track(&msg.name)?;

		let handle = tokio::spawn(async move {
			log::info!("serving track: name={}", track.name);

			if msg.switch_track_id.is_some() && msg.switch_track_id.unwrap() != VarInt::from_u32(0) && this.subscribes.lock().unwrap().get(&msg.switch_track_id.unwrap()).is_some() {
				log::info!("closing track: name={:?}", msg.switch_track_id);
				this.subscribes.lock().unwrap().remove(&msg.switch_track_id.unwrap());
			}

			let res = this.run_subscribe(msg.id, &mut track).await;
			if let Err(err) = &res {
				log::warn!("failed to serve track: name={} err={:#?}", track.name, err);
			}

			if this.subscribes.lock().unwrap().get(&msg.id).is_none() {
				// possibly it was unsubscribed by the client
				log::warn!("subscribe not found: name={}", track.name);
			} else {
				log::info!("closing track: name={}", track.name);
				// Make sure we send a reset at the end.
				let err = res.err().unwrap_or(CacheError::Closed.into());
				this.reset_subscribe(msg.id, err).await.ok();

				// We're all done, so clean up the abort handle.
				this.subscribes.lock().unwrap().remove(&msg.id);
			}
		});

		Ok(handle.abort_handle())
	}

	async fn run_subscribe(&self, id: VarInt, track: &mut track::Subscriber) -> Result<(), SessionError> {
		// TODO add an Ok method to track::Publisher so we can send SUBSCRIBE_OK

		log::info!("in run_subscribe: {:?}", track);

		while let Some(mut segment) = track.segment().await? {
			// Check if the subscribe was removed while waiting for the segment.
			if self.subscribes.lock().unwrap().get(&id).is_none() {
				log::info!("run_subscribe | subscription removed, exiting | track:{} sequence:{:?} priority:{} index:{}", id, segment.sequence, segment.priority, segment.index);
				break
			}

			if self.subscribes.lock().unwrap().get(&id).is_none() {
				// possibly it was unsubscribed by the client
				log::warn!("subscribe not found: {:?}", id);
				return Ok(());
			}

			// TODO only clone the fields we need
			let this = self.clone();

			tokio::spawn(async move {
				if let Err(err) = this.run_segment(id, &mut segment).await {
					log::warn!("failed to serve segment: {:?} {:?}", id, err)
				}
			});

		}

		Ok(())
	}

	async fn run_segment(&self, id: VarInt, segment: &mut segment::Subscriber) -> Result<(), SessionError> {
		log::info!("serving segment | track:{} sequence:{:?} priority:{} index:{}", id, segment.sequence, segment.priority, segment.index);

		let mut stream = self.webtransport.open_uni().await?;

		// Convert the u32 to a i32, since the Quinn set_priority is signed.
		let priority = (segment.priority as i64 - i32::MAX as i64) as i32;
		stream.set_priority(priority).ok();

		let mut sent_chunk_count = 0u32;
		let mut chunk_count = 0u32;
		let chunk_sending_rate = 0;

		let mut internal_buffer = Vec::new();

		while let Some(mut fragment) = segment.fragment().await? {
			log::info!("serving fragment | track:{} sequence:{:?} segment: {:?}", id, fragment.sequence, segment.sequence);
			sent_chunk_count = 0;
			chunk_count = 0;

			// TODO: use real NTP timestamp
			//
			let ntp_timestamp = match VarInt::try_from(chrono::Utc::now().timestamp_millis() as u64) {
				Ok(ntp_timestamp) => ntp_timestamp,
        		Err(e) => return Err(SessionError::BoundsExceeded(e)),
			};

			let object = message::Object {
				track: id,

				// Properties of the segment
				group: segment.sequence,
				priority: segment.priority,
				expires: segment.expires,

				// Properties of the fragment
				sequence: fragment.sequence,

				// timestamp for latency calculation
				ntp_timestamp: Option::from(ntp_timestamp),

				size: fragment.size.map(VarInt::try_from).transpose()?,
			};

			object
			.encode(&mut stream, &self.control.ext)
			.await
			.map_err(|e| SessionError::Unknown(e.to_string()))?;

			// TODO:
			// parse boxes
			// if box length > 200000, send it in one chunk
			// waiting room
			while let Some(chunk) = fragment.chunk().await?
			{
				log::trace!("writing chunk of track: {:?}", chunk);
				if chunk.len() > 0 {
					chunk_count += 1;
					if chunk_sending_rate == 0 {
						let result = stream.write_all(&chunk).await;
						if let Err(err) = result {
							log::warn!("failed to write some chunks ({:?}:{:?} last chunk: {}): {:?}", id, segment.index, chunk_count, err);
						} else {
							// log::debug!("sent chunk | track:{} sequence:{:?} segment: {} chunk_read:{}", id, segment.sequence, segment.index, chunk_count);
						}
						sent_chunk_count += 1;
					} else {
						internal_buffer.append(chunk.to_vec().as_mut());
					}
				}
				if chunk_sending_rate > 0 && chunk_count % chunk_sending_rate == 0 {
					let result = stream.write_all(&internal_buffer).await;
					if let Err(err) = result {
						log::warn!("failed to write some chunks ({:?}:{:?} last chunk: {}): {:?}", id, segment.index, chunk_count, err);
					} else {
						// log::debug!("sent chunk | track:{} sequence:{:?} segment: {} chunk_read:{}", id, segment.sequence, segment.index, chunk_count);
					}
					sent_chunk_count += chunk_sending_rate;
					internal_buffer.clear();
				}
			}
			// log::debug!("finished fragment |track:{:?} segment: {} chunk_read:{} chunk_sent:{}", id, segment.sequence, chunk_count, sent_chunk_count);
		}

		if chunk_count == 0 {
			log::warn!("no chunks sent for track: {:?}", id);
			return Err(SessionError::Unknown("no chunks sent".to_string()));
		} else if chunk_sending_rate > 0 && sent_chunk_count < chunk_count {
			// we did not send the last remaining chunks
			log::warn!("not all chunks sent for track: {:?} chunk count: {:?} sent: {}", id, chunk_count, sent_chunk_count);
			let result = stream.write_all(&internal_buffer).await;
			if let Err(err) = result {
				log::warn!("failed to write some chunks ({:?}:{:?} last chunk: {}): {:?}", id, segment.index, chunk_count, err);
			} else {
				// log::debug!("sent chunk | track:{} sequence:{:?} segment: {} chunk_read:{} chunk_sent:{}", id, segment.sequence, segment.index, chunk_count, sent_chunk_count);
			}
			internal_buffer.clear();
		}

		Ok(())
	}

	async fn recv_unsubscribe(&mut self, msg: &message::Unsubscribe) -> Result<(), SessionError> {
		let abort = self
			.subscribes
			.lock()
			.unwrap()
			.remove(&msg.id)
			.ok_or(CacheError::NotFound)?;
		abort.abort();

		self.reset_subscribe(msg.id, CacheError::Stop).await
	}
}
