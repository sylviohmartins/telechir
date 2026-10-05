use telechir_agent::AgentConfig;

fn main() {
    let config = match AgentConfig::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("telechir-agent configuration error: {error}");
            std::process::exit(2);
        }
    };

    println!(
        "telechir-agent {} core ready (protocol {}, sandbox={})",
        env!("CARGO_PKG_VERSION"),
        config.protocol_version,
        if config.sandbox_enabled() {
            "docker"
        } else {
            "disabled"
        }
    );
}
