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
        "telechir-agent {} core ready (protocol {}, sandbox={}, screen={}, input={}, browser={})",
        env!("CARGO_PKG_VERSION"),
        config.protocol_version,
        if config.sandbox_enabled() {
            "docker"
        } else {
            "disabled"
        },
        if config.computer_screen_enabled {
            "enabled"
        } else {
            "disabled"
        },
        if config.computer_input_enabled {
            "enabled"
        } else {
            "disabled"
        },
        if config.browser_configured() {
            "configured"
        } else {
            "disabled"
        }
    );
}
