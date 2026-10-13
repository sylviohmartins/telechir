use telechir_agent::AgentConfig;
use telechir_agent::host::{HostAction, run_host_action};

#[tokio::main]
async fn main() {
    let config = match AgentConfig::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("telechir-agent configuration error: {error}");
            std::process::exit(2);
        }
    };

    let action = match HostAction::parse(&std::env::args().skip(1).collect::<Vec<_>>()) {
        Ok(action) => action,
        Err(error) => {
            eprintln!("telechir-agent command error: {error}");
            std::process::exit(2);
        }
    };
    if let Err(error) = run_host_action(action, &config).await {
        // Never print the inner HTTP response, credential, challenge, private
        // key, authentication URL, or a token-bearing transport exception.
        eprintln!("telechir-agent host error: {error}");
        std::process::exit(2);
    }
}
