use std::net;

use axum::{
	extract::{Path, State},
	http::StatusCode,
	response::{IntoResponse, Response},
	routing::get,
	Json, Router,
};

use clap::Parser;

use redis::{aio::ConnectionManager, AsyncCommands};

use moq_api::{ApiError, Origin};

/// Runs a HTTP API to create/get origins for broadcasts.
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
pub struct ServerConfig {
	/// Listen for HTTP requests on the given address
	#[arg(long)]
	pub listen: net::SocketAddr,

	/// Connect to the given redis instance
	#[arg(long)]
	pub redis: url::Url,
}

pub struct Server {
	config: ServerConfig,
}

impl Server {
	pub fn new(config: ServerConfig) -> Self {
		Self { config }
	}

	pub async fn run(self) -> Result<(), ApiError> {
		log::info!("connecting to redis: url={}", self.config.redis);

		// Create the redis client.
		let redis = redis::Client::open(self.config.redis)?;
		let redis = redis
			.get_tokio_connection_manager() // TODO get_tokio_connection_manager_with_backoff?
			.await?;

		let app = Router::new()
			.route(
				"/origin/:id",
				get(get_origin)
					.post(set_origin)
					.delete(delete_origin)
					.patch(patch_origin),
			)
			.with_state(redis);

		log::info!("serving requests: bind={}", self.config.listen);

		axum::Server::bind(&self.config.listen)
			.serve(app.into_make_service())
			.await?;

		Ok(())
	}
}

async fn get_origin(
	Path(id): Path<String>,
	State(mut redis): State<ConnectionManager>,
) -> Result<Json<Origin>, AppError> {
	let key = origin_key(&id);

	let payload: Option<String> = redis.get(&key).await?;
	let payload = payload.ok_or(AppError::NotFound)?;
	let origin: Origin = serde_json::from_str(&payload)?;

	Ok(Json(origin))
}

async fn set_origin(
	State(mut redis): State<ConnectionManager>,
	Path(id): Path<String>,
	Json(origin): Json<Origin>,
) -> Result<(), AppError> {
	// TODO validate origin

	let key = origin_key(&id);

	// Convert the input back to JSON after validating it add adding any fields (TODO)
	let payload = serde_json::to_string(&origin)?;

	let res: Option<String> = redis::cmd("SET")
		.arg(key)
		.arg(payload)
		.arg("NX")
		.arg("EX")
		.arg(600) // Set the key to expire in 10 minutes; the origin needs to keep refreshing it.
		.query_async(&mut redis)
		.await?;

	if res.is_none() {
		return Err(AppError::Duplicate);
	}

	Ok(())
}

async fn delete_origin(Path(id): Path<String>, State(mut redis): State<ConnectionManager>) -> Result<(), AppError> {
	let key = origin_key(&id);
	match redis.del(key).await? {
		0 => Err(AppError::NotFound),
		_ => Ok(()),
	}
}

// Update the expiration deadline.
async fn patch_origin(
	Path(id): Path<String>,
	State(mut redis): State<ConnectionManager>,
	Json(origin): Json<Origin>,
) -> Result<(), AppError> {
	let key = origin_key(&id);

	// Make sure the contents haven't changed
	// TODO make a LUA script to do this all in one operation.
	let payload: Option<String> = redis.get(&key).await?;
	let payload = payload.ok_or(AppError::NotFound)?;
	let expected: Origin = serde_json::from_str(&payload)?;

	if expected != origin {
		return Err(AppError::Duplicate);
	}

	// Reset the timeout to 10 minutes.
	match redis.expire(key, 600).await? {
		0 => Err(AppError::NotFound),
		_ => Ok(()),
	}
}

fn origin_key(id: &str) -> String {
	format!("origin.{}", id)
}

#[derive(thiserror::Error, Debug)]
enum AppError {
	#[error("redis error")]
	Redis(#[from] redis::RedisError),

	#[error("json error")]
	Json(#[from] serde_json::Error),

	#[error("not found")]
	NotFound,

	#[error("duplicate ID")]
	Duplicate,
}

// Tell axum how to convert `AppError` into a response.
impl IntoResponse for AppError {
	fn into_response(self) -> Response {
		match self {
			AppError::Redis(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("redis error: {}", e)).into_response(),
			AppError::Json(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("json error: {}", e)).into_response(),
			AppError::NotFound => StatusCode::NOT_FOUND.into_response(),
			AppError::Duplicate => StatusCode::CONFLICT.into_response(),
		}
	}
}
